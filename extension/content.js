// Tekless content script — runs on pump.fun, bullx.io, and dexscreener
// Monitors trade feeds and relays signals to the background service worker

;(() => {
  const site = detectSite()
  if (!site) return

  injectScript()
  setupDispatchListener()
  setupWalletBridge()

  // Give the page time to load the trade feed then start observing
  setTimeout(() => startObserver(site), 2000)

  // Retry observer setup on navigation (SPAs re-render their DOM)
  let lastUrl = location.href
  const navObserver = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href
      setTimeout(() => startObserver(site), 2500)
    }
  })
  navObserver.observe(document, { subtree: true, childList: true })

  // ── Site detection ───────────────────────────────────────────────────────

  function detectSite() {
    const host = location.hostname
    if (host.includes('pump.fun')) return 'pumpfun'
    if (host.includes('bullx.io')) return 'bullx'
    if (host.includes('dexscreener.com')) return 'dexscreener'
    return null
  }

  // ── Inject page-context script (for WS intercept + wallet bridge) ────────

  function injectScript() {
    const s = document.createElement('script')
    s.src = chrome.runtime.getURL('injected.js')
    s.dataset.extensionId = chrome.runtime.id
    ;(document.head || document.documentElement).appendChild(s)
    s.remove()
  }

  // ── Manual dispatch listener (window.dispatchEvent(new CustomEvent('tekless:trade', ...))) ──

  function setupDispatchListener() {
    window.addEventListener('tekless:trade', (e) => {
      const { action, mint, solAmount } = e.detail || {}
      if (!action || !mint) return
      // Convert manual dispatch to a trade signal
      const tradeType = action === 'buy' ? 'sell' : 'buy' // manual dispatch is already the action you want; but we follow the inversion pattern
      // Actually for manual dispatch, let the user specify what THEY want to do directly
      chrome.runtime.sendMessage({
        type: 'MANUAL_TRADE',
        payload: { action, mint, solAmount: solAmount || 0.1 },
      }).catch(() => {})
    })

    // Also listen for raw signals forwarded from injected.js via postMessage
    window.addEventListener('message', (e) => {
      if (e.source !== window) return
      if (!e.data?.tekless) return
      handlePageMessage(e.data)
    })
  }

  function handlePageMessage(data) {
    if (data.type === 'TRADE_SIGNAL') {
      chrome.runtime.sendMessage({ type: 'TRADE_SIGNAL', payload: data.payload }).catch(() => {})
    }
    if (data.type === 'WALLET_ADDRESS') {
      // Cache it for signing requests
      window._teklessWalletAddress = data.address
    }
  }

  // ── Wallet bridge ────────────────────────────────────────────────────────

  function setupWalletBridge() {
    // Background asks content script for the connected wallet address
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.type === 'GET_WALLET_ADDRESS') {
        sendResponse({ address: window._teklessWalletAddress || null })
        return true
      }
      if (msg.type === 'SIGN_TRANSACTION') {
        // Forward to injected.js in page context
        window.postMessage({ tekless: true, type: 'SIGN_TRANSACTION', payload: msg.payload }, '*')
        sendResponse({ ok: true })
        return true
      }
    })

    // Receive sign results from injected.js
    window.addEventListener('message', (e) => {
      if (e.source !== window || !e.data?.tekless) return
      if (e.data.type === 'SIGN_RESULT') {
        chrome.runtime.sendMessage({ type: 'PHANTOM_SIGN_RESULT', payload: e.data.payload }).catch(() => {})
      }
    })
  }

  // ── Trade feed observer ──────────────────────────────────────────────────

  const seenTrades = new Set()
  let currentObserver = null

  function startObserver(site) {
    if (currentObserver) { currentObserver.disconnect(); currentObserver = null }

    const mint = extractMintFromUrl(site)

    // Check if this coin is tracked before setting up observer
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, (res) => {
      if (!res || !res.trackedCoins) return
      if (mint && !res.trackedCoins[mint]) return // not tracked, skip observer

      const container = findTradeContainer(site)
      if (!container) {
        // Retry in 1s if container not found yet
        setTimeout(() => startObserver(site), 1000)
        return
      }

      currentObserver = new MutationObserver((mutations) => {
        for (const mut of mutations) {
          for (const node of mut.addedNodes) {
            if (node.nodeType !== 1) continue
            parseTrade(node, site, mint)
          }
        }
      })
      currentObserver.observe(container, { childList: true, subtree: true })
    })
  }

  function extractMintFromUrl(site) {
    const path = location.pathname
    if (site === 'pumpfun') {
      // https://pump.fun/coin/MINT or https://pump.fun/MINT
      const m = path.match(/\/(?:coin\/)?([1-9A-HJ-NP-Za-km-z]{32,44})/)
      return m ? m[1] : null
    }
    if (site === 'bullx') {
      // https://neo.bullx.io/terminal?chainId=1399811149&address=MINT
      const params = new URLSearchParams(location.search)
      return params.get('address') || null
    }
    if (site === 'dexscreener') {
      // https://dexscreener.com/solana/PAIR_OR_MINT
      const m = path.match(/\/solana\/([1-9A-HJ-NP-Za-km-z]{32,44})/)
      return m ? m[1] : null
    }
    return null
  }

  function findTradeContainer(site) {
    if (site === 'pumpfun') {
      return (
        document.querySelector('[class*="trade"]') ||
        document.querySelector('[class*="Trade"]') ||
        document.querySelector('[data-testid*="trade"]') ||
        document.querySelector('table tbody') ||
        document.querySelector('[class*="transaction"]') ||
        document.querySelector('[class*="feed"]')
      )
    }
    if (site === 'bullx') {
      return (
        document.querySelector('[class*="trades"]') ||
        document.querySelector('[class*="Trade"]') ||
        document.querySelector('[class*="order"]') ||
        document.querySelector('table tbody')
      )
    }
    if (site === 'dexscreener') {
      return (
        document.querySelector('[class*="ds-dex-table"]') ||
        document.querySelector('[data-cy="trade-list"]') ||
        document.querySelector('[class*="tradeTable"]') ||
        document.querySelector('table tbody')
      )
    }
    return null
  }

  // ── Trade row parsing ────────────────────────────────────────────────────

  function parseTrade(node, site, mint) {
    if (!mint) return

    const text = node.innerText || node.textContent || ''
    if (!text.trim()) return

    // De-duplicate: use text hash as key
    const key = `${mint}_${text.slice(0, 80)}`
    if (seenTrades.has(key)) return
    seenTrades.add(key)
    if (seenTrades.size > 500) {
      const first = seenTrades.values().next().value
      seenTrades.delete(first)
    }

    const tradeType = detectTradeType(node, text)
    if (!tradeType) return

    const solAmount = extractSolAmount(text)
    const tokenAmount = extractTokenAmount(text, node)
    const trader = extractTraderAddress(text)

    if (solAmount <= 0 && tokenAmount <= 0) return

    const signal = {
      mint,
      tradeType,
      solAmount,
      tokenAmount,
      trader,
      site,
    }

    chrome.runtime.sendMessage({ type: 'TRADE_SIGNAL', payload: signal }).catch(() => {})
  }

  function detectTradeType(node, text) {
    // Check for buy/sell indicators in element classes or text
    const cls = (node.className || '') + (node.innerHTML || '')
    const lc = cls.toLowerCase() + text.toLowerCase()

    // Explicit class-based detection (most reliable)
    if (node.querySelector?.('[class*="buy" i], [class*="green" i], [data-side="buy"]')) return 'buy'
    if (node.querySelector?.('[class*="sell" i], [class*="red" i], [data-side="sell"]')) return 'sell'

    // Color-based (many DEX UIs color green=buy, red=sell)
    const style = window.getComputedStyle?.(node) || {}
    const color = style.color || ''
    if (color.includes('rgb(0, 200') || color.includes('#00c') || color.includes('green')) return 'buy'
    if (color.includes('rgb(255') || color.includes('#f') || color.includes('red')) return 'sell'

    // Text-based fallback
    if (/\bbuy\b/i.test(text)) return 'buy'
    if (/\bsell\b/i.test(text)) return 'sell'
    if (/\bswap\b.*\bsol\b.*→/i.test(text)) return 'buy'
    if (/→.*\bsol\b/i.test(text)) return 'sell'

    return null
  }

  function extractSolAmount(text) {
    // Match patterns like "0.5 SOL", "1.23SOL", "◎0.5"
    const m = text.match(/(?:◎|SOL\s*)([\d,]+\.?\d*)|(\d+\.?\d*)\s*SOL/i)
    if (m) return parseFloat((m[1] || m[2]).replace(',', ''))
    // Fallback: any decimal number before SOL
    const m2 = text.match(/([\d]+\.[\d]+)\s*(?:SOL|◎)/i)
    if (m2) return parseFloat(m2[1])
    return 0
  }

  function extractTokenAmount(text, node) {
    const m = text.match(/([\d,]+(?:\.[\d]+)?)\s*(?:K|M|B)?\s*(?:tokens?|$)/i)
    if (m) {
      let val = parseFloat(m[1].replace(',', ''))
      const suffix = m[0].match(/[KMB]/)?.[0]?.toUpperCase()
      if (suffix === 'K') val *= 1e3
      if (suffix === 'M') val *= 1e6
      if (suffix === 'B') val *= 1e9
      return val
    }
    return 0
  }

  function extractTraderAddress(text) {
    const m = text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/)
    return m ? m[0] : 'unknown'
  }
})()
