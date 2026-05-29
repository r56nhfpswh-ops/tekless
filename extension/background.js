// Tekless background service worker
// Handles trade execution, state management, and wallet operations

const SOL_MINT = 'So11111111111111111111111111111111111111112'
const JUPITER_QUOTE_URL = 'https://quote-api.jup.ag/v6/quote'
const JUPITER_SWAP_URL = 'https://quote-api.jup.ag/v6/swap'
const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com'

// ── State ──────────────────────────────────────────────────────────────────

let state = {
  trackedCoins: {},   // mint → { symbol, enabled, decimals }
  settings: {
    mode: 'phantom',           // 'phantom' | 'hotwallet'
    privateKey: '',            // base58 full 64-byte keypair
    publicKey: '',             // derived from privateKey
    rpcUrl: DEFAULT_RPC,
    slippageBps: 500,          // 5%
    maxSolPerTrade: 1.0,       // max SOL per single trade
    autoExecute: true,         // skip confirmation
    tradeMode: 'match',        // 'match' = mirror exact SOL | 'full' = 100% balance
    minTradeSol: 0.05,         // ignore trades below this SOL value
    cooldownMs: 3000,          // ms between trades for same coin
  },
  tradeLog: [],
  lastTradeTime: {},  // mint → timestamp
  pendingTrades: {},  // id → { resolve, reject }
}

// ── Init ───────────────────────────────────────────────────────────────────

async function loadState() {
  const stored = await chrome.storage.local.get(['trackedCoins', 'settings', 'tradeLog'])
  if (stored.trackedCoins) state.trackedCoins = stored.trackedCoins
  if (stored.settings) state.settings = { ...state.settings, ...stored.settings }
  if (stored.tradeLog) state.tradeLog = stored.tradeLog
}

async function saveState() {
  await chrome.storage.local.set({
    trackedCoins: state.trackedCoins,
    settings: state.settings,
    tradeLog: state.tradeLog,
  })
}

// ── Message handler ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(sendResponse).catch(err => {
    sendResponse({ error: err.message })
  })
  return true // keep channel open for async
})

async function handleMessage(msg, sender) {
  switch (msg.type) {
    case 'TRADE_SIGNAL':
      return handleTradeSignal(msg.payload, sender.tab?.id)
    case 'GET_STATE':
      return { trackedCoins: state.trackedCoins, settings: sanitizeSettings(), tradeLog: state.tradeLog }
    case 'SET_SETTINGS':
      return applySettings(msg.payload)
    case 'ADD_COIN':
      return addTrackedCoin(msg.payload)
    case 'REMOVE_COIN':
      return removeTrackedCoin(msg.payload.mint)
    case 'TOGGLE_COIN':
      return toggleCoin(msg.payload.mint, msg.payload.enabled)
    case 'CLEAR_LOG':
      state.tradeLog = []
      await saveState()
      return { ok: true }
    case 'PHANTOM_SIGN_RESULT':
      return handlePhantomSignResult(msg.payload)
    case 'MANUAL_TRADE':
      return executeManualTrade(msg.payload)
    case 'GET_BALANCE':
      return getBalances()
    default:
      return { error: 'unknown message type' }
  }
}

// ── Trade signal processing ────────────────────────────────────────────────

async function handleTradeSignal({ mint, tradeType, solAmount, tokenAmount, trader, site }, tabId) {
  const coin = state.trackedCoins[mint]
  if (!coin || !coin.enabled) return { skipped: 'not tracked' }

  // Cooldown check
  const lastTime = state.lastTradeTime[mint] || 0
  if (Date.now() - lastTime < state.settings.cooldownMs) {
    return { skipped: 'cooldown' }
  }

  // Min size filter
  if (solAmount < state.settings.minTradeSol) {
    return { skipped: 'too small' }
  }

  // Invert: if they BUY → we SELL; if they SELL → we BUY
  const ourAction = tradeType === 'buy' ? 'sell' : 'buy'

  logEntry({ type: 'signal', mint, symbol: coin.symbol, tradeType, ourAction, solAmount, tokenAmount, trader, site, ts: Date.now() })

  try {
    state.lastTradeTime[mint] = Date.now()
    const result = await executeTrade(ourAction, mint, coin, solAmount, tabId)
    logEntry({ type: 'executed', mint, symbol: coin.symbol, action: ourAction, ...result, ts: Date.now() })
    notify(`${ourAction.toUpperCase()} ${coin.symbol}`, `${result.outAmount} | Tx: ${result.txSig?.slice(0, 8)}…`)
    return { ok: true, ...result }
  } catch (err) {
    logEntry({ type: 'error', mint, symbol: coin.symbol, action: ourAction, error: err.message, ts: Date.now() })
    notify(`Trade failed: ${coin.symbol}`, err.message)
    return { error: err.message }
  }
}

async function executeTrade(action, mint, coin, signalSolAmount, tabId) {
  const { mode, tradeMode, maxSolPerTrade, slippageBps } = state.settings

  let inputMint, outputMint, inputAmount

  if (action === 'buy') {
    inputMint = SOL_MINT
    outputMint = mint
    if (tradeMode === 'full') {
      const balance = await getSolBalance()
      inputAmount = Math.floor(Math.min(balance * 0.95, maxSolPerTrade) * 1e9) // leave 5% for fees
    } else {
      inputAmount = Math.floor(Math.min(signalSolAmount, maxSolPerTrade) * 1e9)
    }
  } else {
    inputMint = mint
    outputMint = SOL_MINT
    if (tradeMode === 'full') {
      const bal = await getTokenBalance(mint, coin.decimals || 6)
      inputAmount = bal
    } else {
      // estimate token amount from SOL amount using quote
      const quote = await jupiterQuote(SOL_MINT, mint, Math.floor(signalSolAmount * 1e9), slippageBps)
      inputAmount = parseInt(quote.outAmount)
    }
  }

  if (!inputAmount || inputAmount <= 0) throw new Error('Zero input amount')

  const userPublicKey = mode === 'hotwallet' ? state.settings.publicKey : await getConnectedWalletAddress(tabId)
  if (!userPublicKey) throw new Error('No wallet connected')

  const quote = await jupiterQuote(inputMint, outputMint, inputAmount, slippageBps)
  const swapTx = await jupiterSwap(quote, userPublicKey)

  let txSig
  if (mode === 'hotwallet') {
    txSig = await signAndSendHotwallet(swapTx)
  } else {
    txSig = await signAndSendPhantom(swapTx, tabId)
  }

  const outLabel = action === 'buy'
    ? `${(parseInt(quote.outAmount) / Math.pow(10, coin.decimals || 6)).toFixed(2)} ${coin.symbol}`
    : `${(parseInt(quote.outAmount) / 1e9).toFixed(4)} SOL`

  return { txSig, outAmount: outLabel, inputAmount }
}

// ── Jupiter API ────────────────────────────────────────────────────────────

async function jupiterQuote(inputMint, outputMint, amount, slippageBps) {
  const url = `${JUPITER_QUOTE_URL}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}&onlyDirectRoutes=false`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Jupiter quote failed: ${res.status}`)
  const data = await res.json()
  if (data.error) throw new Error(`Jupiter: ${data.error}`)
  return data
}

async function jupiterSwap(quoteResponse, userPublicKey) {
  const res = await fetch(JUPITER_SWAP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    }),
  })
  if (!res.ok) throw new Error(`Jupiter swap failed: ${res.status}`)
  const data = await res.json()
  if (data.error) throw new Error(`Jupiter swap: ${data.error}`)
  return data.swapTransaction // base64 VersionedTransaction
}

// ── Hot wallet signing ─────────────────────────────────────────────────────

async function signAndSendHotwallet(swapTransactionBase64) {
  const { privateKey } = state.settings
  if (!privateKey) throw new Error('No private key configured')

  const secretKeyBytes = base58Decode(privateKey)
  if (secretKeyBytes.length < 32) throw new Error('Invalid private key length')

  const seed = secretKeyBytes.slice(0, 32)
  const txBytes = base64ToBytes(swapTransactionBase64)

  // Sign the transaction message
  const messageBytes = extractTxMessage(txBytes)
  const signature = await ed25519Sign(messageBytes, seed)

  // Rebuild signed transaction
  const signedTx = buildSignedTx(txBytes, signature)
  const signedBase64 = bytesToBase64(signedTx)

  // Send via RPC
  return sendRawTransaction(signedBase64)
}

async function ed25519Sign(message, seed) {
  // Use Web Crypto API Ed25519 (Chrome 113+)
  const key = await crypto.subtle.importKey('raw', seed, { name: 'Ed25519' }, false, ['sign'])
  const sig = await crypto.subtle.sign('Ed25519', key, message)
  return new Uint8Array(sig)
}

function extractTxMessage(txBytes) {
  let offset = 0
  // Read compact-uint for number of signatures
  let numSigs = 0, shift = 0
  do {
    numSigs |= (txBytes[offset] & 0x7F) << shift
    shift += 7
  } while (txBytes[offset++] & 0x80)
  // Skip signatures
  offset += numSigs * 64
  return txBytes.slice(offset)
}

function buildSignedTx(originalTxBytes, signature) {
  const messageBytes = extractTxMessage(originalTxBytes)
  const signed = new Uint8Array(1 + 64 + messageBytes.length)
  signed[0] = 0x01 // 1 signature
  signed.set(signature, 1)
  signed.set(messageBytes, 65)
  return signed
}

async function sendRawTransaction(signedBase64) {
  const rpcUrl = state.settings.rpcUrl || DEFAULT_RPC
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'sendTransaction',
      params: [signedBase64, { encoding: 'base64', preflightCommitment: 'confirmed', skipPreflight: false }],
    }),
  })
  const json = await res.json()
  if (json.error) throw new Error(`RPC: ${json.error.message}`)
  return json.result // transaction signature
}

// ── Phantom signing ────────────────────────────────────────────────────────

async function signAndSendPhantom(swapTransactionBase64, tabId) {
  // Inject the sign request into the active tab via content script
  return new Promise((resolve, reject) => {
    const id = `trade_${Date.now()}`
    state.pendingTrades[id] = { resolve, reject }

    // Set timeout
    setTimeout(() => {
      if (state.pendingTrades[id]) {
        delete state.pendingTrades[id]
        reject(new Error('Wallet sign timeout (30s)'))
      }
    }, 30000)

    chrome.tabs.sendMessage(tabId, {
      type: 'SIGN_TRANSACTION',
      payload: { id, swapTransactionBase64 },
    })
  })
}

function handlePhantomSignResult({ id, txSig, error }) {
  const pending = state.pendingTrades[id]
  if (!pending) return { ok: false }
  delete state.pendingTrades[id]
  if (error) pending.reject(new Error(error))
  else pending.resolve(txSig)
  return { ok: true }
}

// ── Balances ───────────────────────────────────────────────────────────────

async function getSolBalance() {
  const pubkey = state.settings.publicKey
  if (!pubkey) return 0
  const rpc = state.settings.rpcUrl || DEFAULT_RPC
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [pubkey] }),
  })
  const json = await res.json()
  return (json.result?.value || 0) / 1e9
}

async function getTokenBalance(mint, decimals) {
  const pubkey = state.settings.publicKey
  if (!pubkey) return 0
  const rpc = state.settings.rpcUrl || DEFAULT_RPC
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner',
      params: [pubkey, { mint }, { encoding: 'jsonParsed' }],
    }),
  })
  const json = await res.json()
  const accounts = json.result?.value || []
  if (!accounts.length) return 0
  return parseInt(accounts[0].account.data.parsed.info.tokenAmount.amount || '0')
}

async function getBalances() {
  const sol = await getSolBalance()
  const tokens = {}
  for (const [mint, coin] of Object.entries(state.trackedCoins)) {
    tokens[mint] = await getTokenBalance(mint, coin.decimals || 6)
  }
  return { sol, tokens }
}

async function getConnectedWalletAddress(tabId) {
  // Ask content script for the connected wallet address
  return new Promise((resolve) => {
    if (!tabId) { resolve(null); return }
    chrome.tabs.sendMessage(tabId, { type: 'GET_WALLET_ADDRESS' }, (res) => {
      resolve(res?.address || null)
    })
  })
}

// ── Settings / coins ───────────────────────────────────────────────────────

async function applySettings(newSettings) {
  // Derive public key if private key changed
  if (newSettings.privateKey && newSettings.privateKey !== state.settings.privateKey) {
    try {
      const secretBytes = base58Decode(newSettings.privateKey)
      const pubKeyBytes = secretBytes.slice(32, 64) // public key is second half of 64-byte keypair
      newSettings.publicKey = base58Encode(pubKeyBytes)
    } catch {
      return { error: 'Invalid private key' }
    }
  }
  // Never persist the raw private key to storage — store it only in memory
  const toSave = { ...newSettings }
  const privateKey = toSave.privateKey
  delete toSave.privateKey

  state.settings = { ...state.settings, ...newSettings }
  const settingsForStorage = { ...state.settings }
  delete settingsForStorage.privateKey
  await chrome.storage.local.set({ settings: settingsForStorage })
  return { ok: true, publicKey: state.settings.publicKey }
}

async function addTrackedCoin({ mint, symbol, decimals }) {
  if (!mint || !symbol) return { error: 'mint and symbol required' }
  state.trackedCoins[mint] = { symbol, decimals: decimals || 6, enabled: true, addedAt: Date.now() }
  await saveState()
  return { ok: true }
}

async function removeTrackedCoin(mint) {
  delete state.trackedCoins[mint]
  await saveState()
  return { ok: true }
}

async function toggleCoin(mint, enabled) {
  if (state.trackedCoins[mint]) {
    state.trackedCoins[mint].enabled = enabled
    await saveState()
  }
  return { ok: true }
}

function sanitizeSettings() {
  const s = { ...state.settings }
  s.privateKey = s.privateKey ? '••••••••' : ''
  return s
}

// ── Manual trade ───────────────────────────────────────────────────────────

async function executeManualTrade({ action, mint, solAmount }) {
  const coin = state.trackedCoins[mint]
  if (!coin) return { error: 'coin not tracked' }
  return executeTrade(action, mint, coin, solAmount, null)
}

// ── Helpers ────────────────────────────────────────────────────────────────

function logEntry(entry) {
  state.tradeLog.unshift(entry)
  if (state.tradeLog.length > 200) state.tradeLog.pop()
  chrome.storage.local.set({ tradeLog: state.tradeLog })
}

function notify(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: `Tekless: ${title}`,
    message,
  })
}

// base58 encode/decode
const B58_CHARS = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function base58Decode(str) {
  let num = 0n
  for (const c of str) {
    const idx = B58_CHARS.indexOf(c)
    if (idx < 0) throw new Error(`Invalid base58 char: ${c}`)
    num = num * 58n + BigInt(idx)
  }
  const hex = num.toString(16).padStart(Math.ceil(num.toString(16).length / 2) * 2, '0')
  const bytes = hex.match(/.{2}/g).map(h => parseInt(h, 16))
  let leadingZeros = 0
  for (const c of str) { if (c === '1') leadingZeros++; else break }
  return new Uint8Array([...new Array(leadingZeros).fill(0), ...bytes])
}

function base58Encode(bytes) {
  let num = 0n
  for (const b of bytes) num = num * 256n + BigInt(b)
  let result = ''
  while (num > 0n) { result = B58_CHARS[Number(num % 58n)] + result; num /= 58n }
  for (const b of bytes) { if (b === 0) result = '1' + result; else break }
  return result
}

function base64ToBytes(b64) {
  const bin = atob(b64)
  return new Uint8Array(bin.split('').map(c => c.charCodeAt(0)))
}

function bytesToBase64(bytes) {
  return btoa(String.fromCharCode(...bytes))
}

// ── Boot ───────────────────────────────────────────────────────────────────

loadState()
