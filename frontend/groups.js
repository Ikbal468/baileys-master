// ─── Tab Switching ────────────────────────────────────────────────────────────
const tabBtnSend = document.getElementById('tab-btn-send')
const tabBtnGroups = document.getElementById('tab-btn-groups')
const tabSend = document.getElementById('tab-send')
const tabGroups = document.getElementById('tab-groups')

function switchTab(tab) {
	if (tab === 'send') {
		tabBtnSend.classList.add('active')
		tabBtnGroups.classList.remove('active')
		tabSend.classList.remove('hidden')
		tabGroups.classList.add('hidden')
	} else {
		tabBtnGroups.classList.add('active')
		tabBtnSend.classList.remove('active')
		tabGroups.classList.remove('hidden')
		tabSend.classList.add('hidden')
		loadGroups()
	}
}

tabBtnSend.addEventListener('click', () => switchTab('send'))
tabBtnGroups.addEventListener('click', () => switchTab('groups'))

// Sync button handler
const syncGroupsBtn = document.getElementById('syncGroupsBtn')
if (syncGroupsBtn) {
	syncGroupsBtn.addEventListener('click', async () => {
		const originalText = syncGroupsBtn.innerHTML
		syncGroupsBtn.disabled = true
		syncGroupsBtn.innerHTML = '🔄 Syncing...'
		try {
			const res = await fetch('/groups/sync', { method: 'POST' })
			const data = await res.json()
			if (!res.ok) throw new Error(data.error || 'Failed to sync')
			alert(`Sync complete! Loaded groups from WhatsApp successfully.`)
			loadGroups()
		} catch (err) {
			alert('Sync failed: ' + err.message)
		} finally {
			syncGroupsBtn.disabled = false
			syncGroupsBtn.innerHTML = originalText
		}
	})
}

// ─── Group Form State ─────────────────────────────────────────────────────────
const groupForm = document.getElementById('groupForm')
const groupFormTitle = document.getElementById('groupFormTitle')
const groupFormId = document.getElementById('groupFormId')
const groupNameInput = document.getElementById('groupNameInput')
const groupWaIdInput = document.getElementById('groupWaIdInput')
const groupFormError = document.getElementById('groupFormError')
const groupsTableBody = document.getElementById('groupsTableBody')
const inlineSendForm = document.getElementById('inlineSendForm')
const inlineSendGroupId = document.getElementById('inlineSendGroupId')
const inlineSendGroupName = document.getElementById('inlineSendGroupName')
const inlineSendMessage = document.getElementById('inlineSendMessage')
const inlineSendResult = document.getElementById('inlineSendResult')

// ─── Load & Render Groups ─────────────────────────────────────────────────────
async function loadGroups() {
	groupsTableBody.innerHTML = '<tr><td colspan="5" class="empty-row">Loading...</td></tr>'
	try {
		const res = await fetch('/groups')
		if (!res.ok) throw new Error(await res.text())
		const groups = await res.json()
		renderGroupsTable(groups)
	} catch (err) {
		groupsTableBody.innerHTML = `<tr><td colspan="5" class="empty-row error-row">Failed to load groups: ${err.message}</td></tr>`
	}
}

function renderGroupsTable(groups) {
	if (!groups || groups.length === 0) {
		groupsTableBody.innerHTML = '<tr><td colspan="5" class="empty-row">No groups yet. Click "+ Add Group" to create one.</td></tr>'
		return
	}
	groupsTableBody.innerHTML = groups.map((g, idx) => `
		<tr id="row-${g.id}" data-id="${g.id}">
			<td>${idx + 1}</td>
			<td class="group-name-cell"><strong>${escHtml(g.groupName)}</strong></td>
			<td class="group-id-cell"><code>${escHtml(g.whatsappGroupId)}</code></td>
			<td>
				<span class="badge ${g.isActive ? 'badge-active' : 'badge-inactive'}">
					${g.isActive ? '● Active' : '○ Inactive'}
				</span>
			</td>
			<td class="action-btns">
				<button class="btn btn-sm btn-icon" onclick="editGroup(${g.id})" title="Edit">✏️</button>
				<button class="btn btn-sm btn-icon ${g.isActive ? 'btn-warn' : 'btn-success'}"
					onclick="toggleActive(${g.id}, ${g.isActive})" title="${g.isActive ? 'Deactivate' : 'Activate'}">
					${g.isActive ? '⏸' : '▶'}
				</button>
				<button class="btn btn-sm btn-icon btn-danger" onclick="deleteGroup(${g.id}, '${escHtml(g.groupName)}')" title="Delete">🗑</button>
				<button class="btn btn-sm primary" onclick="openSendForm(${g.id}, '${escHtml(g.groupName)}')" ${!g.isActive ? 'disabled title="Group is inactive"' : ''}>
					📢 Send
				</button>
			</td>
		</tr>
	`).join('')
}

// ─── Add / Edit Group ─────────────────────────────────────────────────────────
document.getElementById('addGroupBtn').addEventListener('click', () => {
	groupFormId.value = ''
	groupNameInput.value = ''
	groupWaIdInput.value = ''
	groupFormTitle.textContent = 'Add Group'
	hideError()
	groupForm.classList.remove('hidden')
	groupNameInput.focus()
	closeSendForm()
})

document.getElementById('cancelGroupBtn').addEventListener('click', () => {
	groupForm.classList.add('hidden')
	hideError()
})

document.getElementById('saveGroupBtn').addEventListener('click', async () => {
	const id = groupFormId.value
	const groupName = groupNameInput.value.trim()
	const whatsappGroupId = groupWaIdInput.value.trim()

	if (!groupName || !whatsappGroupId) {
		showError('Both Group Name and WhatsApp Group ID are required.')
		return
	}

	const method = id ? 'PUT' : 'POST'
	const url = id ? `/groups/${id}` : '/groups'

	try {
		const res = await fetch(url, {
			method,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ groupName, whatsappGroupId }),
		})
		const data = await res.json()
		if (!res.ok) {
			showError(data.error || JSON.stringify(data))
			return
		}
		groupForm.classList.add('hidden')
		hideError()
		loadGroups()
	} catch (err) {
		showError('Request failed: ' + err.message)
	}
})

async function editGroup(id) {
	closeSendForm()
	try {
		const res = await fetch(`/groups/${id}`)
		const g = await res.json()
		if (!res.ok) return alert('Could not load group: ' + g.error)
		groupFormId.value = g.id
		groupNameInput.value = g.groupName
		groupWaIdInput.value = g.whatsappGroupId
		groupFormTitle.textContent = 'Edit Group'
		hideError()
		groupForm.classList.remove('hidden')
		groupNameInput.focus()
	} catch (err) {
		alert('Error: ' + err.message)
	}
}

// ─── Toggle Active ─────────────────────────────────────────────────────────────
async function toggleActive(id, currentState) {
	try {
		const res = await fetch(`/groups/${id}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ isActive: !currentState }),
		})
		if (!res.ok) {
			const d = await res.json()
			return alert('Error: ' + d.error)
		}
		loadGroups()
	} catch (err) {
		alert('Error: ' + err.message)
	}
}

// ─── Delete Group ─────────────────────────────────────────────────────────────
async function deleteGroup(id, name) {
	if (!confirm(`Delete group "${name}"? This cannot be undone.`)) return
	try {
		const res = await fetch(`/groups/${id}`, { method: 'DELETE' })
		const data = await res.json()
		if (!res.ok) return alert('Error: ' + data.error)
		closeSendForm()
		groupForm.classList.add('hidden')
		loadGroups()
	} catch (err) {
		alert('Error: ' + err.message)
	}
}

// ─── Inline Send Form ─────────────────────────────────────────────────────────
function openSendForm(id, name) {
	groupForm.classList.add('hidden')
	inlineSendGroupId.value = id
	inlineSendGroupName.textContent = `Send to: ${name}`
	inlineSendMessage.value = ''
	inlineSendResult.classList.add('hidden')
	inlineSendResult.textContent = ''
	inlineSendForm.classList.remove('hidden')
	inlineSendMessage.focus()
}

function closeSendForm() {
	inlineSendForm.classList.add('hidden')
	inlineSendResult.classList.add('hidden')
}

document.getElementById('closeSendFormBtn').addEventListener('click', closeSendForm)

document.getElementById('submitSendGroupBtn').addEventListener('click', async () => {
	const id = inlineSendGroupId.value
	const message = inlineSendMessage.value.trim()
	if (!message) {
		inlineSendResult.textContent = '⚠️ Please type a message before sending.'
		inlineSendResult.className = 'form-result error-result'
		inlineSendResult.classList.remove('hidden')
		return
	}

	const btn = document.getElementById('submitSendGroupBtn')
	btn.disabled = true
	btn.textContent = 'Sending...'

	try {
		const res = await fetch(`/groups/${id}/send`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ message }),
		})
		const data = await res.json()
		if (!res.ok) {
			inlineSendResult.textContent = '❌ ' + (data.error || JSON.stringify(data))
			inlineSendResult.className = 'form-result error-result'
		} else {
			inlineSendResult.textContent = `✅ Message sent to "${data.groupName}" successfully!`
			inlineSendResult.className = 'form-result success-result'
			inlineSendMessage.value = ''
		}
	} catch (err) {
		inlineSendResult.textContent = '❌ Request failed: ' + err.message
		inlineSendResult.className = 'form-result error-result'
	} finally {
		inlineSendResult.classList.remove('hidden')
		btn.disabled = false
		btn.textContent = '📢 Send to Group'
	}
})

// ─── Helpers ──────────────────────────────────────────────────────────────────
function showError(msg) {
	groupFormError.textContent = msg
	groupFormError.classList.remove('hidden')
}

function hideError() {
	groupFormError.textContent = ''
	groupFormError.classList.add('hidden')
}

function escHtml(str) {
	return String(str)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
}

// Expose to inline onclick handlers
window.editGroup = editGroup
window.toggleActive = toggleActive
window.deleteGroup = deleteGroup
window.openSendForm = openSendForm
