import './styles.css';
import {
  importPrivateKey,
  getKeypair,
  buildConnection,
  setConnection,
  getConnection,
  getSolBalance,
} from './wallet.js';
import { loadPositionsDirect, removeLiquidity, parseBps } from './meteora.js';
import { loadDynamicAmmPool, removeDynamicAmmLiquidity, parseDynamicBps } from './dynamicAmm.js';

// ── State ─────────────────────────────────────────────────────────────────────
let poolType    = null;   // 'dlmm' | 'dynamic'
let dlmmPool    = null;   // { pool, positions, totalSol, totalTokenRaw, address }
let dynamicData = null;   // from loadDynamicAmmPool
let rpcConnected = false;

// ── DOM ───────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const walletBadge   = $('wallet-badge');
const pkInput       = $('pk-input');
const walletInfo    = $('wallet-info');
const walletAddr    = $('wallet-address');
const solBalance    = $('sol-balance');

const heliusKey     = $('helius-key');
const customUrl     = $('custom-url');
const connectRpc    = $('connect-rpc-btn');
const rpcStatusRow  = $('rpc-status-row');
const rpcDot        = $('rpc-dot');
const rpcStatusTxt  = $('rpc-status-text');

const poolAddrInput = $('pool-addr-input');
const loadDirectBtn = $('load-direct-btn');
const poolList      = $('pool-list');
const positionBox   = $('position-box');
const posCount      = $('pos-count');
const posSol        = $('pos-sol');
const posToken      = $('pos-token');

const amountInput   = $('amount-input');
const removeBtn     = $('remove-btn');
const log           = $('log');

// ── RPC tabs ──────────────────────────────────────────────────────────────────
let activeRpc = 'helius';
['helius', 'jupiter', 'custom'].forEach(id => {
  $(`tab-${id}`).addEventListener('click', () => {
    activeRpc = id;
    ['helius', 'jupiter', 'custom'].forEach(t => {
      $(`tab-${t}`).classList.toggle('active', t === id);
      $(`${t}-cfg`).classList.toggle('hidden', t !== id);
    });
  });
});

// ── Log ───────────────────────────────────────────────────────────────────────
function addLog(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `log-entry ${type}`;
  el.textContent = `${ts()} ${msg}`;
  log.prepend(el);
}
function ts() { return new Date().toTimeString().slice(0, 8); }
function setLoading(btn, on, label) {
  btn.disabled = on;
  btn.innerHTML = on ? `<span class="spinner"></span>${label}` : label;
}

// ── Wallet ────────────────────────────────────────────────────────────────────
$('import-btn').addEventListener('click', async () => {
  const val = pkInput.value.trim();
  if (!val) return;
  try {
    const address = importPrivateKey(val);
    pkInput.value = '';
    walletAddr.textContent = address;
    walletInfo.classList.remove('hidden');
    walletBadge.textContent = address.slice(0,4) + '…' + address.slice(-4);
    walletBadge.classList.add('connected');
    addLog(`Wallet imported: ${address}`, 'success');
    if (rpcConnected) await refreshBalance();
  } catch (e) {
    addLog(`Wallet error: ${e.message}`, 'error');
  }
});

// ── RPC ───────────────────────────────────────────────────────────────────────
connectRpc.addEventListener('click', async () => {
  setLoading(connectRpc, true, 'Connecting…');
  rpcStatusRow.classList.add('hidden');
  try {
    const conn = buildConnection(activeRpc, heliusKey.value, customUrl.value);
    const slot = await conn.getSlot();
    setConnection(conn);
    rpcConnected = true;
    rpcDot.className = 'status-dot ok';
    rpcStatusTxt.textContent = `Connected · slot ${slot.toLocaleString()}`;
    rpcStatusRow.classList.remove('hidden');
    loadDirectBtn.disabled = false;
    addLog('RPC connected', 'success');
    if (getKeypair()) await refreshBalance();
  } catch (e) {
    rpcDot.className = 'status-dot err';
    rpcStatusTxt.textContent = `Error: ${e.message}`;
    rpcStatusRow.classList.remove('hidden');
    addLog(`RPC error: ${e.message}`, 'error');
  } finally {
    setLoading(connectRpc, false, 'Connect RPC');
  }
});

async function refreshBalance() {
  try {
    const bal = await getSolBalance();
    if (bal !== null)
      solBalance.innerHTML = `Balance: <span>${bal.toFixed(4)} SOL</span>`;
  } catch {}
}

// ── Load pool (auto-detects DLMM vs Dynamic AMM) ─────────────────────────────
loadDirectBtn.addEventListener('click', async () => {
  const addr = poolAddrInput.value.trim();
  if (!addr) return;
  const keypair = getKeypair();
  if (!keypair) { addLog('Import a wallet first', 'warn'); return; }

  setLoading(loadDirectBtn, true, 'Loading…');
  positionBox.classList.add('hidden');
  removeBtn.disabled = true;
  poolType = null; dlmmPool = null; dynamicData = null;

  try {
    // Try DLMM first
    let loaded = false;
    try {
      const result = await loadPositionsDirect(getConnection(), addr, keypair.publicKey);
      dlmmPool = result;
      poolType = 'dlmm';
      showBox(result.positions.length, result.totalSol, result.totalTokenRaw);
      addLog(`DLMM · ${result.positions.length} position(s) · ${result.totalSol.toFixed(4)} SOL`, 'success');
      loaded = true;
    } catch (e) {
      if (!e.message.toLowerCase().includes('discriminator') &&
          !e.message.toLowerCase().includes('decode') &&
          !e.message.toLowerCase().includes('invalid')) throw e;
    }

    if (!loaded) {
      // Dynamic AMM V2
      addLog('Detected Dynamic AMM pool…', 'info');
      const result = await loadDynamicAmmPool(getConnection(), addr, keypair.publicKey);
      if (result.lpBalance.isZero()) {
        addLog('No LP tokens found for your wallet in this pool', 'warn');
        return;
      }
      dynamicData = result;
      poolType = 'dynamic';
      showBox(1, result.totalSol, result.totalTokenRaw);
      addLog(`Dynamic AMM · ${result.totalSol.toFixed(4)} SOL · ${result.lpBalance.toString()} LP`, 'success');
    }

    removeBtn.disabled = false;
  } catch (e) {
    addLog(`Error: ${e.message}`, 'error');
  } finally {
    setLoading(loadDirectBtn, false, 'Load');
  }
});

function showBox(count, sol, token) {
  posCount.textContent = count;
  posSol.textContent   = `${sol.toFixed(6)} SOL`;
  posToken.textContent = formatAmt(token);
  positionBox.classList.remove('hidden');
}

// ── All button ────────────────────────────────────────────────────────────────
$('all-btn').addEventListener('click', () => { amountInput.value = 'all'; });

// ── Remove liquidity ──────────────────────────────────────────────────────────
removeBtn.addEventListener('click', async () => {
  if (!poolType) { addLog('Load a pool first', 'warn'); return; }
  const keypair = getKeypair();
  if (!keypair) { addLog('Import a wallet first', 'warn'); return; }

  const amtRaw = amountInput.value.trim();
  if (!amtRaw) { addLog('Enter an amount', 'warn'); return; }

  const totalSol = poolType === 'dynamic' ? dynamicData.totalSol : dlmmPool.totalSol;

  let bps;
  try {
    bps = poolType === 'dynamic'
      ? parseDynamicBps(amtRaw, totalSol)
      : parseBps(amtRaw, totalSol);
  } catch (e) {
    addLog(`Amount error: ${e.message}`, 'error');
    return;
  }

  const pct = `${(bps / 100).toFixed(1)}%`;
  addLog(`Removing ${pct}…`, 'info');
  setLoading(removeBtn, true, `Removing ${pct}…`);

  try {
    let sigs = [];

    if (poolType === 'dynamic') {
      const sig = await removeDynamicAmmLiquidity(getConnection(), dynamicData, keypair, bps);
      sigs = [sig];
    } else {
      sigs = await removeLiquidity(getConnection(), dlmmPool.pool, dlmmPool.positions, keypair, bps);
    }

    for (const sig of sigs) {
      const entry = document.createElement('div');
      entry.className = 'log-entry success';
      entry.innerHTML = `${ts()} TX confirmed · <a class="tx-link" href="https://solscan.io/tx/${sig}" target="_blank" rel="noopener">${sig.slice(0,20)}…</a>`;
      log.prepend(entry);
    }

    addLog(`Done — ${sigs.length} tx(s) confirmed`, 'success');
    await refreshBalance();

    // Refresh position display
    const k2 = getKeypair();
    if (k2) {
      try {
        if (poolType === 'dynamic') {
          dynamicData = await loadDynamicAmmPool(getConnection(), dynamicData.poolAddress, k2.publicKey);
          showBox(1, dynamicData.totalSol, dynamicData.totalTokenRaw);
          if (dynamicData.lpBalance.isZero()) { removeBtn.disabled = true; addLog('Position fully removed', 'info'); }
        } else {
          const r = await loadPositionsDirect(getConnection(), dlmmPool.address, k2.publicKey);
          dlmmPool = r;
          showBox(r.positions.length, r.totalSol, r.totalTokenRaw);
          if (r.positions.length === 0) { removeBtn.disabled = true; addLog('Position fully closed', 'info'); }
        }
      } catch {}
    }
  } catch (e) {
    addLog(`Remove error: ${e.message}`, 'error');
  } finally {
    if (!removeBtn.disabled) setLoading(removeBtn, false, 'Remove Liquidity');
    else removeBtn.textContent = 'Remove Liquidity';
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatAmt(raw) {
  if (raw >= 1_000_000) return (raw / 1_000_000).toFixed(4) + 'M';
  if (raw >= 1_000)     return (raw / 1_000).toFixed(4) + 'K';
  return raw.toLocaleString();
}
