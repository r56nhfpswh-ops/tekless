// Tekless injected script — runs in page context (has access to window.solana)
// Intercepts WebSocket trade feeds and bridges wallet signing

;(() => {
  const EXT_ID = document.currentScript?.dataset?.extensionId

  // ── WebSocket intercept ──────────────────────────────────────────────────
  // Wraps the native WebSocket to sniff trade feed messages from the site

  const OrigWebSocket = window.WebSocket
  window.WebSocket = class TeklessWebSocket extends OrigWebSocket {
    constructor(url, protocols) {
      super(url, protocols)
      this.addEventListener('message', (e) => {
        try {
          const data = JSON.parse(e.data)
          const signal = parseTradeFeedMessage(data, url)
          if (signal) {
            window.postMessage({ tekless: true, type: 'TRADE_SIGNAL', payload: signal }, '*')
          }
        } catch {}
      })
    }
  }

  function parseTradeFeedMessage(data, wsUrl) {
    // pump.fun WebSocket format
    if (data?.txType === 'buy' || data?.txType === 'sell') {
      return {
        mint: data.mint,
        tradeType: data.txType,
        solAmount: (data.solAmount || 0) / 1e9,
        tokenAmount: data.tokenAmount || 0,
        trader: data.traderPublicKey || 'unknown',
        site: 'pumpfun',
      }
    }

    // Alternative pump.fun format
    if (data?.type === 'trade' && data?.data?.mint) {
      return {
        mint: data.data.mint,
        tradeType: data.data.is_buy ? 'buy' : 'sell',
        solAmount: (data.data.sol_amount || 0) / 1e9,
        tokenAmount: data.data.token_amount || 0,
        trader: data.data.user || 'unknown',
        site: 'pumpfun',
      }
    }

    // bullx / generic DEX format
    if (data?.event === 'trade' || data?.type === 'swap') {
      const d = data.data || data
      const isBuy = d.type === 'buy' || d.side === 'buy' || d.isBuy === true
      return {
        mint: d.tokenAddress || d.mint || d.baseToken?.address,
        tradeType: isBuy ? 'buy' : 'sell',
        solAmount: parseFloat(d.amountSol || d.solAmount || d.quoteAmount || 0),
        tokenAmount: parseFloat(d.amountToken || d.tokenAmount || d.baseAmount || 0),
        trader: d.maker || d.wallet || d.user || 'unknown',
        site: 'ws',
      }
    }

    // DEXscreener WebSocket
    if (Array.isArray(data) && data[0]?.type === 'trade') {
      const d = data[0]
      return {
        mint: d.pair?.baseToken?.address || d.mint,
        tradeType: d.priceChangePercent > 0 ? 'buy' : 'sell',
        solAmount: parseFloat(d.volume || 0),
        tokenAmount: 0,
        trader: d.txHash || 'unknown',
        site: 'dexscreener',
      }
    }

    return null
  }

  // ── Wallet bridge ────────────────────────────────────────────────────────
  // Bridges the extension's signing requests to window.solana (Phantom)

  // Report connected wallet address
  function reportWalletAddress() {
    const addr = window.solana?.publicKey?.toString() || window.phantom?.solana?.publicKey?.toString()
    if (addr) {
      window.postMessage({ tekless: true, type: 'WALLET_ADDRESS', address: addr }, '*')
    }
  }

  // Poll for wallet connection
  const addrPoll = setInterval(() => {
    if (window.solana?.isConnected || window.solana?.publicKey) {
      reportWalletAddress()
      clearInterval(addrPoll)
    }
  }, 500)
  setTimeout(() => clearInterval(addrPoll), 30000)

  // Listen for wallet events
  window.solana?.on?.('connect', reportWalletAddress)

  // Listen for sign requests from content script
  window.addEventListener('message', async (e) => {
    if (e.source !== window || !e.data?.tekless) return
    if (e.data.type !== 'SIGN_TRANSACTION') return

    const { id, swapTransactionBase64 } = e.data.payload

    try {
      const wallet = window.solana || window.phantom?.solana
      if (!wallet) throw new Error('No Solana wallet found. Install Phantom.')
      if (!wallet.isConnected) {
        await wallet.connect()
      }

      // Decode the base64 transaction
      const txBytes = base64ToBytes(swapTransactionBase64)

      // Use Phantom's sendTransaction for VersionedTransaction
      // Phantom accepts Uint8Array or Transaction objects
      const result = await wallet.signAndSendTransaction(
        deserializeVersionedTx(txBytes)
      )

      window.postMessage({
        tekless: true,
        type: 'SIGN_RESULT',
        payload: { id, txSig: result.signature, error: null },
      }, '*')
    } catch (err) {
      window.postMessage({
        tekless: true,
        type: 'SIGN_RESULT',
        payload: { id, txSig: null, error: err.message },
      }, '*')
    }
  })

  // ── Manual dispatch API ──────────────────────────────────────────────────
  // Usage: window.dispatchEvent(new CustomEvent('tekless:trade', {
  //   detail: { action: 'buy', mint: 'TOKEN_MINT_ADDRESS', solAmount: 0.1 }
  // }))

  window.__tekless = {
    version: '1.0.0',
    buy: (mint, solAmount = 0.1) => {
      window.dispatchEvent(new CustomEvent('tekless:trade', { detail: { action: 'buy', mint, solAmount } }))
    },
    sell: (mint, solAmount = 0) => {
      window.dispatchEvent(new CustomEvent('tekless:trade', { detail: { action: 'sell', mint, solAmount } }))
    },
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  function base64ToBytes(b64) {
    const bin = atob(b64)
    return new Uint8Array(bin.split('').map(c => c.charCodeAt(0)))
  }

  // Minimal VersionedTransaction deserializer for Phantom signAndSendTransaction
  // Phantom accepts { serialize() } shaped objects or raw Uint8Array via some methods
  function deserializeVersionedTx(bytes) {
    // Phantom's newer API accepts a raw Uint8Array passed as a "message"
    // Return an object that mimics VersionedTransaction interface for Phantom
    return {
      serialize: () => bytes,
      _bytes: bytes,
    }
  }
})()
