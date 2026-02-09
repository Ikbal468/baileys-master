const statusEl = document.getElementById('status')
const qrArea = document.getElementById('qrArea')
const qrcodeEl = document.getElementById('qrcode')
const connectedEl = document.getElementById('connectedNumber')
const chatLog = document.getElementById('chatLog')
const logoutBtn = document.getElementById('logoutBtn')
const fileInput = document.getElementById('fileInput')
const filePreview = document.getElementById('filePreview')
const mediaType = document.getElementById('mediaType')

let qrCodeWidget = null
const knownMessageIds = new Set()

async function pollMessages() {
	try {
		const res = await fetch('/messages')
		if (!res.ok) return
		const j = await res.json()
		const msgs = Array.isArray(j.messages) ? j.messages : []
		// msgs are newest-first; iterate from end to start to display oldest-first
		for (let i = msgs.length - 1; i >= 0; i--) {
			const m = msgs[i]
			if (!m || !m.id) continue
			if (knownMessageIds.has(m.id)) continue
			knownMessageIds.add(m.id)
			const el = document.createElement('div')
			el.className = 'chatItem'
			const left = document.createElement('div')
			const from = m.from || 'unknown'
			const displayText = m.text || '[media]'
			left.textContent = `From ${from}: ${displayText}`
			const time = document.createElement('div')
			time.className = 'time'
			const d = m.timestamp ? new Date(m.timestamp) : new Date()
			time.textContent = d.toLocaleTimeString()
			el.appendChild(left)
			el.appendChild(time)
			chatLog.prepend(el)
		}
	} catch (e) {
		// ignore polling errors
	}
}

async function fetchSession() {
	try {
		const res = await fetch('/session')
		const data = await res.json()
		console.log('Session data:', data)
		return data
	} catch (e) {
		console.error('Error fetching session:', e)
		return { connected: false }
	}
}

async function fetchQR() {
	try {
		const res = await fetch('/qr')
		const data = await res.json()
		console.log('QR data:', data)
		return data
	} catch (e) {
		console.error('Error fetching QR:', e)
		return { qr: null }
	}
}

async function refresh() {
	console.log('Refreshing...')
	const s = await fetchSession()

	// update status badge with proper classes
	statusEl.className = 'status'

	// Priority order: check if QR is needed first
	// hide logout unless authenticated
	if (logoutBtn) logoutBtn.style.display = 'none'

	if (s.needsQR) {
		console.log('QR needed, fetching QR...')
		// needs QR scan
		statusEl.textContent = 'Waiting for QR scan'
		statusEl.classList.add('waiting')
		connectedEl.textContent = ''
		const { qr } = await fetchQR()
		console.log('QR received:', qr ? 'Yes' : 'No')
		qrcodeEl.innerHTML = ''
		if (qr) {
			console.log('Generating QR code...')
			qrCodeWidget = new QRCode(qrcodeEl, {
				text: qr,
				width: 280,
				height: 280,
				colorDark: '#000000',
				colorLight: '#ffffff',
				correctLevel: QRCode.CorrectLevel.L
			})
		}
		return
	}

	// Check if authenticated
	if (s.authenticated && s.connected) {
		console.log('Authenticated and connected')
		statusEl.textContent = 'Connected'
		statusEl.classList.add('connected')
		connectedEl.textContent = s.number ? `Connected: ${s.number}` : ''
		qrcodeEl.innerHTML = ''
		if (logoutBtn) logoutBtn.style.display = 'inline-block'
		return
	}

	// Not connected at all
	if (!s.connected) {
		console.log('Not connected')
		statusEl.textContent = 'Disconnected'
		statusEl.classList.add('disconnected')
		connectedEl.textContent = ''
		qrcodeEl.innerHTML = ''
		if (logoutBtn) logoutBtn.style.display = 'none'
		return
	}

	// Default: connecting state
	console.log('Connecting state')
	statusEl.textContent = 'Connecting...'
	statusEl.classList.add('waiting')
	connectedEl.textContent = ''
	qrcodeEl.innerHTML = ''
}

document.getElementById('sendForm').addEventListener('submit', async e => {
	e.preventDefault()
	const number = document.getElementById('number').value.trim()
	const message = document.getElementById('message').value.trim()
	const hasFile = fileInput && fileInput.files && fileInput.files.length > 0
	if (!number) return alert('Please fill number')
	if (!message && !hasFile) return alert('Please fill message or attach a file')

	// check number first
	try {
		const check = await fetch('/check-number', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ number })
		})
		const chk = await check.json()
		if (chk.exists !== true) {
			// exists === false OR exists === null
			return alert('This number is not registered on WhatsApp (or could not be verified)')
		}
	} catch (err) {
		console.error('check-number error', err)
		if (!confirm('Number check failed; still send message?')) return
	}

	let data = null
	if (hasFile) {
		const f = fileInput.files[0]
		const form = new FormData()
		form.append('number', number)
		form.append('message', message)
		form.append('mediaType', mediaType ? mediaType.value : 'auto')
		form.append('file', f)

		const res = await fetch('/send-media', { method: 'POST', body: form })
		data = await res.json()
		if (!res.ok) return alert('Error: ' + (data?.error || JSON.stringify(data)))
	} else {
		const res = await fetch('/send-message', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ number, message })
		})
		data = await res.json()
		if (!res.ok) return alert('Error: ' + (data?.error || JSON.stringify(data)))
	}
	const el = document.createElement('div')
	el.className = 'chatItem'
	const left = document.createElement('div')
	left.textContent = data.success ? `To ${data.to}: ${data.text}` : `Error: ${data.error || data.details}`
	const time = document.createElement('div')
	time.className = 'time'
	time.textContent = new Date().toLocaleTimeString()
	el.appendChild(left)
	el.appendChild(time)
	chatLog.prepend(el)
	if (data.success) {
		document.getElementById('message').value = ''
		// clear file input & preview if a file was sent
		if (fileInput) {
			fileInput.value = ''
			clearFilePreview()
		}
	}
})

document.getElementById('clearBtn').addEventListener('click', () => {
	document.getElementById('number').value = ''
	document.getElementById('message').value = ''
	if (fileInput) {
		fileInput.value = ''
		clearFilePreview()
	}
})

// Check number UI handler
const checkNumberInput = document.getElementById('checkNumber')
const checkNumberBtn = document.getElementById('checkNumberBtn')
const checkResult = document.getElementById('checkResult')

// if (checkNumberBtn) {
// 	checkNumberBtn.addEventListener('click', async () => {
// 		const n = checkNumberInput && checkNumberInput.value ? checkNumberInput.value.trim() : ''
// 		if (!n) return alert('Please enter a number to check')
// 		try {
// 			const res = await fetch('/check-number', {
// 				method: 'POST',
// 				headers: { 'Content-Type': 'application/json' },
// 				body: JSON.stringify({ number: n })
// 			})
// 			const j = await res.json()
// 			if (!res.ok) return alert('Error: ' + (j.error || JSON.stringify(j)))
// 			if (j.exists === true) {
// 				checkResult.textContent = `${n} is registered on WhatsApp (jid: ${j.jid || 'unknown'})`
// 			} else if (j.exists === false) {
// 				checkResult.textContent = `${n} is NOT registered on WhatsApp`
// 			} else {
// 				checkResult.textContent = `Could not verify ${n}`
// 			}
// 		} catch (e) {
// 			console.error('check-number error', e)
// 			alert('Request failed: ' + (e && e.message))
// 		}
// 	})
// }

function clearFilePreview() {
	if (!filePreview) return
	// revoke any object URL images
	const img = filePreview.querySelector('img')
	if (img && img._objURL) {
		URL.revokeObjectURL(img._objURL)
	}
	filePreview.innerHTML = ''
}

if (fileInput) {
	fileInput.addEventListener('change', () => {
		filePreview.innerHTML = ''
		if (!fileInput.files || fileInput.files.length === 0) return
		const f = fileInput.files[0]
		const chip = document.createElement('div')
		chip.className = 'file-chip'

		if (f.type && f.type.startsWith('image/')) {
			const img = document.createElement('img')
			img.className = 'file-thumb'
			const obj = URL.createObjectURL(f)
			img.src = obj
			img._objURL = obj
			chip.appendChild(img)
		}

		const label = document.createElement('div')
		label.textContent = f.name
		chip.appendChild(label)

		const remove = document.createElement('button')
		remove.type = 'button'
		remove.className = 'file-remove'
		remove.textContent = 'Remove'
		remove.addEventListener('click', () => {
			fileInput.value = ''
			clearFilePreview()
		})
		chip.appendChild(remove)

		filePreview.appendChild(chip)
	})
}

document.getElementById('logoutBtn').addEventListener('click', async () => {
	if (!confirm('Are you sure you want to logout from WhatsApp?')) return

	try {
		const res = await fetch('/logout', { method: 'POST' })
		const data = await res.json()

		if (data.success) {
			alert('Logged out successfully. New QR code will appear shortly.')
			setTimeout(refresh, 1000)
		}
	} catch (e) {
		alert('Logout failed: ' + ((e && e.message) || e))
	}
})

// start polling
setInterval(refresh, 2000)
refresh()
// poll incoming messages
setInterval(pollMessages, 2000)
pollMessages()
