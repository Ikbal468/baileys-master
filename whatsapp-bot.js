import 'reflect-metadata'
import makeWASocket, { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } from './lib/index.js'
import { AppDataSource } from './data-source.js'
import express from 'express'
import qrcode from 'qrcode-terminal'
import pino from 'pino'
import fs from 'fs'
import path from 'path'
import os from 'os'
import multer from 'multer'

const app = express()
app.use(express.json())
// serve frontend
app.use(express.static(path.join(process.cwd(), 'frontend')))

// multer setup for file uploads
const upload = multer({ dest: os.tmpdir() })

let sock = null
let groupRepo = null
let qrGenerated = false
let lastQR = null
let connectedNumber = null
// In-memory store for received messages (last first)
const messagesStore = []
// quick lookup to avoid duplicate messages
const messageIds = new Set()

// Function to clear auth folder
function clearAuthFolder() {
	const authPath = './auth_info_baileys'
	try {
		if (fs.existsSync(authPath)) {
			fs.rmSync(authPath, { recursive: true, force: true })
			console.log('✅ Authentication files cleared successfully')
		}
	} catch (error) {
		console.error('❌ Error clearing auth folder:', error.message)
	}
}

async function syncWhatsAppGroups() {
	if (!sock || typeof sock.groupFetchAllParticipating !== 'function') {
		console.log('⚠️ Cannot sync groups: socket not ready or function not supported')
		return 0
	}
	try {
		console.log('🔄 Fetching all participating groups from WhatsApp...')
		const groups = await sock.groupFetchAllParticipating()
		const groupList = Object.values(groups)
		console.log(`Found ${groupList.length} groups. Syncing with database...`)
		let count = 0
		for (const g of groupList) {
			let group = await groupRepo.findOneBy({ whatsappGroupId: g.id })
			if (!group) {
				group = groupRepo.create({
					groupName: g.subject || 'Unnamed Group',
					whatsappGroupId: g.id,
					isActive: true
				})
				await groupRepo.save(group)
				console.log(`✅ Saved new group: "${g.subject}" (${g.id})`)
				count++
			} else {
				if (group.groupName !== g.subject) {
					group.groupName = g.subject
					await groupRepo.save(group)
					console.log(`✏️ Updated group name: "${g.subject}" (${g.id})`)
					count++
				}
			}
		}
		return groupList.length
	} catch (err) {
		console.error('❌ Error syncing groups:', err)
		throw err
	}
}

async function connectToWhatsApp() {
	const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys')

	// Fetch the latest WhatsApp Web version to ensure QR code generation works
	const { version, isLatest } = await fetchLatestBaileysVersion()
	console.log(`Using WA v${version.join('.')}, isLatest: ${isLatest}`)

	sock = makeWASocket({
		version,
		auth: state,
		printQRInTerminal: false,
		logger: pino({ level: 'silent' })
	})

	sock.ev.on('creds.update', saveCreds)

	sock.ev.on('connection.update', update => {
		const { connection, lastDisconnect, qr } = update

		if (qr && !qrGenerated) {
			console.log('\n=== SCAN THIS QR CODE WITH WHATSAPP ===\n')
			qrcode.generate(qr, { small: true })
			console.log('\nOpen WhatsApp on your phone → Settings → Linked Devices → Link a Device\n')
			lastQR = qr
			qrGenerated = true
		}

		if (connection === 'close') {
			const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
			console.log('Connection closed. Reconnecting:', shouldReconnect)

			if (shouldReconnect) {
				qrGenerated = false
				connectToWhatsApp()
			} else {
				// User logged out, clear auth files and reconnect to get new QR
				console.log('⚠️  Logged out. Clearing authentication files...')
				clearAuthFolder()
				sock = null
				connectedNumber = null
				lastQR = null
				qrGenerated = false

				// Reconnect after a short delay to generate new QR
				setTimeout(() => {
					console.log('🔄 Reconnecting to generate new QR code...')
					connectToWhatsApp()
				}, 2000)
			}
		} else if (connection === 'open') {
			console.log('\n✅ Connected to WhatsApp Successfully!\n')
			// store connected id if available
			connectedNumber = sock?.user?.id || null
			lastQR = null
			qrGenerated = false

			// Auto sync groups shortly after connection opens
			setTimeout(() => {
				syncWhatsAppGroups().catch(err => {
					console.error('Auto group sync failed:', err.message)
				})
			}, 3000)
		}
	})

	sock.ev.on('messages.upsert', async m => {
		const msg = m.messages[0]
		try {
			if (!msg.key.fromMe && m.type === 'notify') {
				// extract text from common message types
				let text = null
				if (msg.message?.conversation) text = msg.message.conversation
				else if (msg.message?.extendedTextMessage?.text) text = msg.message.extendedTextMessage.text
				else if (msg.message?.imageMessage?.caption) text = msg.message.imageMessage.caption
				else if (msg.message?.documentMessage?.caption) text = msg.message.documentMessage.caption
				else if (msg.message?.videoMessage?.caption) text = msg.message.videoMessage.caption

				const from = msg.key.remoteJid || null
				const id = msg.key.id || `${from}_${msg.messageTimestamp || Date.now()}`
				const ts =
					msg?.messageTimestamp && Number(msg.messageTimestamp) ? Number(msg.messageTimestamp) * 1000 : Date.now()

				// dedupe by id to avoid repeated upserts adding the same message
				if (messageIds.has(id)) {
					console.log('Duplicate message skipped:', id)
				} else {
					const entry = { id, from, text: text || '[media]', timestamp: ts }
					// keep store bounded
					messagesStore.unshift(entry)
					messageIds.add(id)
					if (messagesStore.length > 200) {
						const removed = messagesStore.pop()
						if (removed && removed.id) messageIds.delete(removed.id)
					}

					console.log('📩 Received message:', entry)
				}
			}
		} catch (e) {
			console.error('Error processing incoming message:', e)
		}
	})
}

// API Endpoints

// Send message endpoint
app.post('/send-message', async (req, res) => {
	try {
		const { number, message } = req.body

		if (!number || !message) {
			return res.status(400).json({
				error: 'Missing required fields: number and message',
				example: {
					number: '5511999999999',
					message: 'Hello from Baileys!'
				}
			})
		}

		if (!sock) {
			return res.status(503).json({
				error: 'WhatsApp not connected. Please scan QR code first.'
			})
		}

		// Check if number is on WhatsApp
		try {
			const checkNum = number.includes('@') ? number.split('@')[0] : number
			if (typeof sock.onWhatsApp === 'function') {
				const resCheck = await sock.onWhatsApp(checkNum)
				// if we got a definitive response, enforce it
				if (Array.isArray(resCheck) && resCheck[0] && typeof resCheck[0].exists === 'boolean') {
					if (!resCheck[0].exists) {
						return res.status(400).json({ error: 'Number is not registered on WhatsApp' })
					}
				} else {
					// cannot verify number -> block to avoid sending to non-whatsapp numbers
					return res.status(400).json({ error: 'Could not verify number on WhatsApp' })
				}
			} else {
				// onWhatsApp not supported -> block to be safe
				return res.status(400).json({ error: 'Number verification not available on server' })
			}
		} catch (err) {
			console.error('Error checking number:', err)
			// block on error to avoid accidental sends
			return res.status(500).json({ error: 'Error while verifying number', details: err.message })
		}

		// Format number to WhatsApp format (with country code)
		const formattedNumber = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`

		// Check if recipient exists on WhatsApp before sending media
		try {
			const checkNum = number.includes('@') ? number.split('@')[0] : number
			if (typeof sock.onWhatsApp === 'function') {
				const resCheck = await sock.onWhatsApp(checkNum)
				if (Array.isArray(resCheck) && resCheck[0] && typeof resCheck[0].exists === 'boolean') {
					if (!resCheck[0].exists) {
						return res.status(400).json({ error: 'Number is not registered on WhatsApp' })
					}
				} else {
					return res.status(400).json({ error: 'Could not verify number on WhatsApp' })
				}
			} else {
				return res.status(400).json({ error: 'Number verification not available on server' })
			}
		} catch (err) {
			console.error('Error checking number before media send:', err)
			// proceed if check fails
			return res.status(500).json({ error: 'Error while verifying number', details: err.message })
		}

		await sock.sendMessage(formattedNumber, { text: message })

		console.log(`✉️  Message sent to ${formattedNumber}`)

		res.json({
			success: true,
			message: 'Message sent successfully',
			to: formattedNumber,
			text: message
		})
	} catch (error) {
		console.error('❌ Error sending message:', error)
		res.status(500).json({
			error: 'Failed to send message',
			details: error.message
		})
	}
})

// Send message with media (image, document, etc.)
app.post('/send-media', upload.single('file'), async (req, res) => {
	try {
		const { number, url, caption, type } = req.body

		if (!number) {
			return res.status(400).json({ error: 'Missing required field: number' })
		}

		if (!sock) {
			return res.status(503).json({ error: 'WhatsApp not connected. Please scan QR code first.' })
		}

		const formattedNumber = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`

		// verify recipient
		try {
			const checkNum = number.includes('@') ? number.split('@')[0] : number
			if (typeof sock.onWhatsApp === 'function') {
				const resCheck = await sock.onWhatsApp(checkNum)
				if (Array.isArray(resCheck) && resCheck[0] && typeof resCheck[0].exists === 'boolean') {
					if (!resCheck[0].exists) {
						return res.status(400).json({ error: 'Number is not registered on WhatsApp' })
					}
				} else {
					return res.status(400).json({ error: 'Could not verify number on WhatsApp' })
				}
			} else {
				return res.status(400).json({ error: 'Number verification not available on server' })
			}
		} catch (err) {
			console.error('Error checking number before media send:', err)
			return res.status(500).json({ error: 'Error while verifying number', details: err.message })
		}

		let messageContent = null

		// If an uploaded file is present, send it
		if (req.file) {
			const filePath = req.file.path
			const mime = req.file.mimetype || ''
			const filename = req.file.originalname || 'file'

			if (mime.startsWith('image/')) {
				messageContent = { image: { url: filePath }, caption: caption || '' }
			} else if (mime.startsWith('video/')) {
				messageContent = { video: { url: filePath }, caption: caption || '' }
			} else {
				// treat as document
				messageContent = {
					document: fs.readFileSync(filePath),
					fileName: filename,
					mimetype: mime,
					caption: caption || ''
				}
			}
		} else if (url) {
			// fallback to URL-based sending
			const messageType = type || 'image'
			messageContent = { [messageType]: { url }, caption: caption || '' }
		} else {
			return res.status(400).json({ error: 'Missing media: provide a file upload or url' })
		}

		await sock.sendMessage(formattedNumber, messageContent)

		// cleanup uploaded file
		if (req.file && req.file.path) {
			try {
				fs.unlinkSync(req.file.path)
			} catch (e) {
				/* ignore */
			}
		}

		console.log(`🖼️  Media sent to ${formattedNumber}`)

		res.json({ success: true, message: 'Media sent successfully', to: formattedNumber })
	} catch (error) {
		console.error('❌ Error sending media:', error)
		res.status(500).json({ error: 'Failed to send media', details: error.message })
	}
})

// Check number endpoint
// Helper: check whether a single number is registered on WhatsApp
async function checkWhatsAppNumberSingle(n) {
	if (!sock) throw new Error('WhatsApp not connected')
	const checkNum = n.includes('@') ? n.split('@')[0] : n
	if (typeof sock.onWhatsApp === 'function') {
		// wrap with timeout to avoid very long waits
		const call = sock.onWhatsApp(checkNum)
		const timeoutMs = 4000
		const r = await Promise.race([
			call,
			new Promise((_, rej) => setTimeout(() => rej(new Error('onWhatsApp timeout')), timeoutMs))
		])
		if (Array.isArray(r) && r[0]) {
			// some implementations return contact object instead of boolean for `exists`
			return { exists: !!r[0].exists, jid: r[0].jid || null }
		}
	}
	// unknown / unsupported
	return { exists: null, jid: null }
}

// Consolidated: check one or many numbers
// Accepts { number: '5511999...', numbers: ['55...','55...'] }
app.post('/check-number', async (req, res) => {
	try {
		const { number, numbers } = req.body || {}
		if (!number && (!numbers || !Array.isArray(numbers) || numbers.length === 0)) {
			return res.status(400).json({ error: 'Provide `number` or `numbers` array' })
		}

		if (!sock) return res.status(503).json({ error: 'WhatsApp not connected' })

		const toCheck = []
		if (number) toCheck.push(number)
		if (Array.isArray(numbers)) toCheck.push(...numbers)

		const results = []
		const notRegistered = []
		for (const n of toCheck) {
			try {
				const r = await checkWhatsAppNumberSingle(n)
				results.push({ number: n, exists: r.exists, jid: r.jid })
				if (r.exists === false) notRegistered.push(n)
			} catch (err) {
				results.push({ number: n, error: err.message })
			}
		}

		// If any number is definitively not registered, return 400 with details
		if (notRegistered.length > 0) {
			return res.status(400).json({ error: 'One or more numbers are not registered on WhatsApp', notRegistered })
		}

		// if only a single input number was provided, return single object for convenience
		if (number && !numbers) return res.json(results[0])
		return res.json({ results })
	} catch (err) {
		console.error('Error in check-number:', err)
		res.status(500).json({ error: err.message })
	}
})

// Check connection status
app.get('/status', (req, res) => {
	res.json({
		connected: sock !== null,
		authenticated: qrGenerated === false && sock !== null,
		needsQR: qrGenerated
	})
})

// Health check
app.get('/health', (req, res) => {
	res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// expose QR for frontend
app.get('/qr', (req, res) => {
	res.json({ qr: lastQR })
})

// session info
app.get('/session', (req, res) => {
	res.json({
		connected: sock !== null,
		authenticated: qrGenerated === false && sock !== null,
		needsQR: qrGenerated,
		number: connectedNumber
	})
})

// Return recent received messages
app.get('/messages', (req, res) => {
	try {
		// return up to 100 most recent messages
		return res.json({ messages: messagesStore.slice(0, 100) })
	} catch (err) {
		console.error('Error returning messages:', err)
		res.status(500).json({ error: err.message })
	}
})

// Logout endpoint
app.post('/logout', async (req, res) => {
	try {
		if (sock) {
			await sock.logout()
			console.log('🔓 Logging out from WhatsApp...')

			res.json({
				success: true,
				message: 'Logged out successfully. New QR code will be generated automatically.'
			})
		} else {
			res.status(400).json({ error: 'Not connected' })
		}
	} catch (error) {
		res.status(500).json({ error: error.message })
	}
})

// ─── Group CRUD & Send Routes ────────────────────────────────────────────────

// POST /groups/sync — manual trigger to fetch participating groups and save them in DB
app.post('/groups/sync', async (req, res) => {
	try {
		if (!sock) {
			return res.status(503).json({ error: 'WhatsApp not connected. Please scan QR code first.' })
		}
		const count = await syncWhatsAppGroups()
		res.json({ success: true, count, message: `Successfully synced groups.` })
	} catch (err) {
		console.error('Error in /groups/sync:', err)
		res.status(500).json({ error: 'Failed to sync groups', details: err.message })
	}
})

// GET /groups — list all groups
app.get('/groups', async (req, res) => {
	try {
		const groups = await groupRepo.find({ order: { createdAt: 'DESC' } })
		res.json(groups)
	} catch (err) {
		console.error('Error fetching groups:', err)
		res.status(500).json({ error: err.message })
	}
})

// GET /groups/:id — get single group
app.get('/groups/:id', async (req, res) => {
	try {
		const group = await groupRepo.findOneBy({ id: Number(req.params.id) })
		if (!group) return res.status(404).json({ error: 'Group not found' })
		res.json(group)
	} catch (err) {
		res.status(500).json({ error: err.message })
	}
})

// POST /groups — create a group
app.post('/groups', async (req, res) => {
	try {
		const { groupName, whatsappGroupId } = req.body
		if (!groupName || !whatsappGroupId) {
			return res.status(400).json({ error: 'groupName and whatsappGroupId are required' })
		}
		const group = groupRepo.create({ groupName, whatsappGroupId, isActive: true })
		const saved = await groupRepo.save(group)
		res.status(201).json(saved)
	} catch (err) {
		if (err.message && err.message.includes('UNIQUE')) {
			return res.status(409).json({ error: 'A group with that WhatsApp Group ID already exists' })
		}
		res.status(500).json({ error: err.message })
	}
})

// PUT /groups/:id — update a group
app.put('/groups/:id', async (req, res) => {
	try {
		const group = await groupRepo.findOneBy({ id: Number(req.params.id) })
		if (!group) return res.status(404).json({ error: 'Group not found' })
		const { groupName, whatsappGroupId, isActive } = req.body
		if (groupName !== undefined) group.groupName = groupName
		if (whatsappGroupId !== undefined) group.whatsappGroupId = whatsappGroupId
		if (isActive !== undefined) group.isActive = isActive
		const updated = await groupRepo.save(group)
		res.json(updated)
	} catch (err) {
		res.status(500).json({ error: err.message })
	}
})

// DELETE /groups/:id — delete a group
app.delete('/groups/:id', async (req, res) => {
	try {
		const group = await groupRepo.findOneBy({ id: Number(req.params.id) })
		if (!group) return res.status(404).json({ error: 'Group not found' })
		await groupRepo.remove(group)
		res.json({ success: true, message: 'Group deleted' })
	} catch (err) {
		res.status(500).json({ error: err.message })
	}
})

// POST /groups/:id/send — send text message to a WhatsApp group
app.post('/groups/:id/send', async (req, res) => {
	try {
		const { message } = req.body
		if (!message) return res.status(400).json({ error: 'message is required' })

		const group = await groupRepo.findOneBy({ id: Number(req.params.id) })
		if (!group) return res.status(404).json({ error: 'Group not found' })
		if (!group.isActive) return res.status(400).json({ error: `Group "${group.groupName}" is not active` })
		if (!sock) return res.status(503).json({ error: 'WhatsApp not connected. Please scan QR code first.' })

		// Group IDs end with @g.us — send as-is, no @s.whatsapp.net appending
		await sock.sendMessage(group.whatsappGroupId, { text: message })
		console.log(`📢 Group message sent to "${group.groupName}" (${group.whatsappGroupId})`)

		res.json({ success: true, to: group.whatsappGroupId, groupName: group.groupName, text: message })
	} catch (err) {
		console.error('Error sending group message:', err)
		res.status(500).json({ error: 'Failed to send group message', details: err.message })
	}
})

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3150

AppDataSource.initialize()
	.then(() => {
		console.log('✅ Database initialized (whatsapp.db)')
		groupRepo = AppDataSource.getRepository('WhatsappGroup')

		app.listen(PORT, () => {
			console.log('='.repeat(50))
			console.log('🚀 WhatsApp Bot API Server Started!')
			console.log('='.repeat(50))
			console.log(`\n📡 Server running on: http://localhost:${PORT}`)
			console.log(`\n📋 Available endpoints:`)
			console.log(`   POST http://localhost:${PORT}/send-message`)
			console.log(`   POST http://localhost:${PORT}/send-media`)
			console.log(`   POST http://localhost:${PORT}/logout`)
			console.log(`   GET  http://localhost:${PORT}/status`)
			console.log(`   GET  http://localhost:${PORT}/health`)
			console.log(`   GET  http://localhost:${PORT}/groups`)
			console.log(`   POST http://localhost:${PORT}/groups`)
			console.log(`   PUT  http://localhost:${PORT}/groups/:id`)
			console.log(`   DELETE http://localhost:${PORT}/groups/:id`)
			console.log(`   POST http://localhost:${PORT}/groups/:id/send`)
			console.log(`\n🔌 Connecting to WhatsApp...\n`)
			connectToWhatsApp()
		})
	})
	.catch(err => {
		console.error('❌ Failed to initialize database:', err)
		process.exit(1)
	})
