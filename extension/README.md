# Tekless — Solana Memecoin Trader

Browser extension that monitors trade feeds on **pump.fun**, **BullX**, and **DEXscreener** and automatically executes counter-trades:

| Detected trade | Your action |
|---|---|
| Someone **BUYS** a tracked coin | You **SELL** |
| Someone **SELLS** a tracked coin | You **BUY** |

---

## Install

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select the `extension/` folder
4. Pin the Tekless extension icon to your toolbar

---

## Quick start

1. Click the Tekless icon → **Settings** tab
2. Choose wallet mode:
   - **Phantom** — uses your connected Phantom wallet (you'll approve each trade)
   - **Hot Wallet** — paste your 64-byte base58 keypair for fully automatic trading
3. Go to **Coins** tab → add the token mint address + symbol for each coin to track
4. Navigate to that coin on pump.fun or DEXscreener — trades will be detected automatically

---

## Wallet modes

### Phantom mode (safer)
The extension sends each trade through your Phantom wallet. A popup will appear asking you to approve.

### Hot Wallet mode (fully automated)
Paste your **64-byte base58 private key** (as exported from `solana-keygen` or Phantom's export).  
- The key is stored locally in `chrome.storage.local` only — never transmitted
- Trades execute without any popup
- ⚠️ Only use a dedicated trading wallet with limited funds

---

## Dispatch API

You can trigger trades manually from the browser console on any supported site:

```js
// Buy a coin
window.__tekless.buy('TOKEN_MINT_ADDRESS', 0.1) // 0.1 SOL

// Sell a coin
window.__tekless.sell('TOKEN_MINT_ADDRESS')

// Or using raw CustomEvent:
window.dispatchEvent(new CustomEvent('tekless:trade', {
  detail: { action: 'buy', mint: 'TOKEN_MINT_ADDRESS', solAmount: 0.5 }
}))
```

---

## Settings

| Setting | Description |
|---|---|
| Trade Mode | **Match** = mirror the exact SOL amount from the signal. **Full** = use 100% of your SOL/token balance |
| Max SOL per trade | Hard cap per trade (protects against large unexpected trades) |
| Min trade size | Ignore signals below this SOL value (filter noise) |
| Slippage | BPS tolerance. 500 = 5%. Memecoins often need 500–1000 |
| Cooldown | Minimum ms between trades for the same coin |
| RPC Endpoint | Use a private RPC (Helius, QuickNode) for faster execution |

---

## Supported sites

- `pump.fun` — WebSocket trade feed + DOM observer
- `neo.bullx.io` / `bullx.io` — WebSocket + DOM
- `dexscreener.com/solana/*` — WebSocket + DOM

---

## Security notes

- Never put your main wallet's private key into this extension
- Use a fresh wallet with only the SOL you're willing to trade
- Always test with small amounts first
- This is experimental software — use at your own risk
