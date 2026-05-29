// Tekless popup controller

let globalState = { trackedCoins: {}, settings: {}, tradeLog: [] }

// ── Boot ───────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await loadState()
  setupTabs()
  setupCoinsTab()
  setupLogTab()
  setupSettingsTab()
  updateStatusBar()
})

async function loadState() {
  globalState = await bg('GET_STATE')
}

function bg(type, payload) {
  return chrome.runtime.sendMessage({ type, payload })
}

// ── Tabs ───────────────────────────────────────────────────────────────────

function setupTabs() {
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'))
      document.querySelectorAll('.tab-content').forEach(s => s.classList.remove('active'))
      btn.classList.add('active')
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active')
    })
  })
}

// ── Coins tab ──────────────────────────────────────────────────────────────

function setupCoinsTab() {
  renderCoins()
  document.getElementById('btn-add-coin').addEventListener('click', addCoin)
  document.getElementById('coin-mint').addEventListener('keydown', e => { if (e.key === 'Enter') addCoin() })
}

async function addCoin() {
  const mint = document.getElementById('coin-mint').value.trim()
  const symbol = document.getElementById('coin-symbol').value.trim().toUpperCase()
  const decimals = parseInt(document.getElementById('coin-decimals').value) || 6

  if (!mint || !symbol) return

  await bg('ADD_COIN', { mint, symbol, decimals })
  await loadState()
  renderCoins()

  document.getElementById('coin-mint').value = ''
  document.getElementById('coin-symbol').value = ''
}

function renderCoins() {
  const list = document.getElementById('coins-list')
  const coins = globalState.trackedCoins || {}
  const entries = Object.entries(coins)

  if (!entries.length) {
    list.innerHTML = '<p class="hint" style="padding:8px 0">No coins tracked yet. Add a token mint address above.</p>'
    return
  }

  list.innerHTML = entries.map(([mint, coin]) => `
    <div class="coin-item" data-mint="${mint}">
      <span class="coin-symbol">${escHtml(coin.symbol)}</span>
      <span class="coin-mint" title="${escHtml(mint)}">${mint.slice(0, 8)}…${mint.slice(-4)}</span>
      <div class="coin-actions">
        <input class="toggle coin-toggle" type="checkbox" title="Enable/disable" ${coin.enabled ? 'checked' : ''}>
        <button class="btn btn-danger btn-sm coin-remove" title="Remove">✕</button>
      </div>
    </div>
  `).join('')

  list.querySelectorAll('.coin-toggle').forEach(el => {
    el.addEventListener('change', async e => {
      const mint = e.target.closest('.coin-item').dataset.mint
      await bg('TOGGLE_COIN', { mint, enabled: e.target.checked })
      await loadState()
      updateStatusBar()
    })
  })

  list.querySelectorAll('.coin-remove').forEach(el => {
    el.addEventListener('click', async e => {
      const mint = e.target.closest('.coin-item').dataset.mint
      await bg('REMOVE_COIN', { mint })
      await loadState()
      renderCoins()
      updateStatusBar()
    })
  })
}

// ── Log tab ────────────────────────────────────────────────────────────────

function setupLogTab() {
  renderLog()
  document.getElementById('btn-clear-log').addEventListener('click', async () => {
    await bg('CLEAR_LOG')
    await loadState()
    renderLog()
  })
}

function renderLog() {
  const log = globalState.tradeLog || []
  const el = document.getElementById('trade-log')
  const countEl = document.getElementById('log-count')

  countEl.textContent = `${log.length} entries`

  if (!log.length) {
    el.innerHTML = '<p class="hint" style="padding:8px 0">No trades yet. Visit a tracked coin page to start monitoring.</p>'
    return
  }

  el.innerHTML = log.map(entry => {
    const time = new Date(entry.ts).toLocaleTimeString()

    if (entry.type === 'signal') {
      return `<div class="log-entry signal">
        <span class="log-time">${time}</span>
        <span> Signal: <b>${escHtml(entry.symbol)}</b> — detected <span class="log-action ${entry.tradeType}">${entry.tradeType.toUpperCase()}</span> → will <span class="log-action ${entry.ourAction}">${entry.ourAction.toUpperCase()}</span> (${entry.solAmount.toFixed(4)} SOL)</span>
      </div>`
    }

    if (entry.type === 'executed') {
      return `<div class="log-entry executed">
        <span class="log-time">${time}</span>
        <span> ✓ <span class="log-action ${entry.action}">${entry.action.toUpperCase()}</span> <b>${escHtml(entry.symbol)}</b> → ${escHtml(entry.outAmount)} <a class="tx-link" href="https://solscan.io/tx/${entry.txSig}" target="_blank" title="${entry.txSig}">${entry.txSig?.slice(0, 8)}…</a></span>
      </div>`
    }

    if (entry.type === 'error') {
      return `<div class="log-entry error">
        <span class="log-time">${time}</span>
        <span> ✗ <b>${escHtml(entry.symbol)}</b> ${entry.action?.toUpperCase()}: ${escHtml(entry.error)}</span>
      </div>`
    }

    return ''
  }).join('')
}

// ── Settings tab ───────────────────────────────────────────────────────────

function setupSettingsTab() {
  const s = globalState.settings || {}

  // Populate fields
  setRadio('mode', s.mode || 'phantom')
  setVal('rpc-url', s.rpcUrl || '')
  setVal('trade-mode', s.tradeMode || 'match')
  setVal('max-sol', s.maxSolPerTrade || 1.0)
  setVal('min-sol', s.minTradeSol || 0.05)
  setVal('slippage', s.slippageBps || 500)
  setVal('cooldown', s.cooldownMs || 3000)

  // Show hot wallet section if in hotwallet mode
  toggleHotwalletSection(s.mode === 'hotwallet')
  document.querySelectorAll('input[name="mode"]').forEach(radio => {
    radio.addEventListener('change', () => toggleHotwalletSection(radio.value === 'hotwallet'))
  })

  if (s.publicKey) {
    showPubkey(s.publicKey)
  }

  document.getElementById('btn-save-settings').addEventListener('click', saveSettings)
}

function toggleHotwalletSection(show) {
  document.getElementById('hotwallet-section').classList.toggle('hidden', !show)
}

async function saveSettings() {
  const btn = document.getElementById('btn-save-settings')
  btn.disabled = true

  const mode = document.querySelector('input[name="mode"]:checked').value
  const privateKey = document.getElementById('private-key').value.trim()

  const payload = {
    mode,
    rpcUrl: document.getElementById('rpc-url').value.trim() || 'https://api.mainnet-beta.solana.com',
    tradeMode: document.getElementById('trade-mode').value,
    maxSolPerTrade: parseFloat(document.getElementById('max-sol').value) || 1.0,
    minTradeSol: parseFloat(document.getElementById('min-sol').value) || 0.05,
    slippageBps: parseInt(document.getElementById('slippage').value) || 500,
    cooldownMs: parseInt(document.getElementById('cooldown').value) || 3000,
  }

  if (mode === 'hotwallet' && privateKey) {
    payload.privateKey = privateKey
  }

  const res = await bg('SET_SETTINGS', payload)
  btn.disabled = false

  const msgEl = document.getElementById('settings-msg')
  if (res?.error) {
    showMsg('error', `Error: ${res.error}`)
  } else {
    showMsg('success', 'Settings saved!')
    if (res?.publicKey) showPubkey(res.publicKey)
    await loadState()
    updateStatusBar()
  }
}

function showPubkey(pubkey) {
  const el = document.getElementById('pubkey-display')
  el.textContent = `Wallet: ${pubkey}`
  el.classList.remove('hidden')
}

function showMsg(type, text) {
  const el = document.getElementById('settings-msg')
  el.textContent = text
  el.className = `msg ${type}`
  el.classList.remove('hidden')
  setTimeout(() => el.classList.add('hidden'), 3000)
}

// ── Status bar ─────────────────────────────────────────────────────────────

function updateStatusBar() {
  const coins = globalState.trackedCoins || {}
  const activeCount = Object.values(coins).filter(c => c.enabled).length
  const dot = document.getElementById('status-dot')
  const text = document.getElementById('status-text')
  const badge = document.getElementById('wallet-badge')

  const pubkey = globalState.settings?.publicKey
  if (pubkey) {
    badge.textContent = `${pubkey.slice(0, 4)}…${pubkey.slice(-4)}`
    badge.classList.remove('hidden')
  }

  if (activeCount > 0) {
    dot.className = 'dot dot-active'
    text.textContent = `Watching ${activeCount} coin${activeCount > 1 ? 's' : ''}`
  } else {
    dot.className = 'dot dot-off'
    text.textContent = 'Idle'
  }
}

// ── Utils ──────────────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function setVal(id, val) {
  const el = document.getElementById(id)
  if (el) el.value = val
}

function setRadio(name, val) {
  const el = document.querySelector(`input[name="${name}"][value="${val}"]`)
  if (el) el.checked = true
}
