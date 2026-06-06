import './styles.css';
import {
  importPrivateKey,
  getKeypair,
  buildConnection,
  setConnection,
  getConnection,
  getSolBalance,
} from './wallet.js';
import {
  findUserPoolsForToken,
  createPoolInstance,
  loadPositionsDirect,
  removeLiquidity,
  parseBps,
} from './meteora.js';

// ── State ─────────────────────────────────────────────────────────────────────
let selectedPool = null;  // item from findUserPoolsForToken()
let poolInstance  = null; // DLMM instance for the selected pool
let rpcConnected  = false;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const walletBadge  = $('wallet-badge');
const pkInput      = $('pk-input');
const importBtn    = $('import-btn');
const walletInfo   = $('wallet-info');
const walletAddr   = $('wallet-address');
const solBalance   = $('sol-balance');

const heliusKey    = $('helius-key');
const customUrl    = $('custom-url');
const connectRpc   = $('connect-rpc-btn');
const rpcStatusRow = $('rpc-status-row');
const rpcDot       = $('rpc-dot');
const rpcStatusTxt = $('rpc-status-text');

const mintInput      = $('mint-input');
const loadPoolBtn    = $('load-pool-btn');
const poolAddrInput  = $('pool-addr-input');
const loadDirectBtn  = $('load-direct-btn');
const poolList       = $('pool-list');
const positionBox  = $('position-box');
const posCount     = $('pos-count');
const posSol       = $('pos-sol');
const posToken     = $('pos-token');

const amountInput  = $('amount-input');
const removeBtn    = $('remove-btn');
const log          = $('log');

// ── RPC tabs ──────────────────────────────────────────────────────────────────
let activeRpc = 'helius';
['helius', 'jupiter', 'custom'].forEach((id) => {
  $(`tab-${id}`).addEventListener('click', () => {
    activeRpc = id;
    ['helius', 'jupiter', 'custom'].forEach((t) => {
      $(`tab-${t}`).classList.toggle('active', t === id);
      $(`${t}-cfg`).classList.toggle('hidden', t !== id);
    });
  });
});

// ── Logging ───────────────────────────────────────────────────────────────────
function addLog(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `log-entry ${type}`;
  el.textContent = `${ts()} ${msg}`;
  log.prepend(el);
}
function ts() { return new Date().toTimeString().slice(0, 8); }

function setLoading(btn, loading, label) {
  btn.disabled = loading;
  btn.innerHTML = loading ? `<span class="spinner"></span>${label}` : label;
}

// ── Wallet ────────────────────────────────────────────────────────────────────
importBtn.addEventListener('click', async () => {
  const val = pkInput.value.trim();
  if (!val) return;
  try {
    const address = importPrivateKey(val);
    pkInput.value = '';
    walletAddr.textContent = address;
    walletInfo.classList.remove('hidden');
    walletBadge.textContent = address.slice(0, 4) + '…' + address.slice(-4);
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
    loadPoolBtn.disabled  = false;
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

// ── Pool / position loading ───────────────────────────────────────────────────
loadPoolBtn.addEventListener('click', async () => {
  const mint = mintInput.value.trim();
  if (!mint) return;

  const keypair = getKeypair();
  if (!keypair) { addLog('Import a wallet first', 'warn'); return; }

  setLoading(loadPoolBtn, true, 'Scanning…');
  poolList.innerHTML = '';
  poolList.classList.add('hidden');
  positionBox.classList.add('hidden');
  selectedPool = null;
  poolInstance  = null;
  removeBtn.disabled = true;

  try {
    addLog('Scanning all your Meteora positions on-chain…', 'info');
    const { pools, totalPositions } = await findUserPoolsForToken(getConnection(), mint, keypair.publicKey);

    addLog(`Scanned ${totalPositions} total position(s) across all DLMM pools`, 'info');

    if (pools.length === 0) {
      addLog(`No positions matched this token CA. Try entering the pool address directly below.`, 'warn');
      return;
    }

    addLog(`Found ${pools.length} matching pool(s)`, 'success');
    renderPoolList(pools);
  } catch (e) {
    addLog(`Error: ${e.message}`, 'error');
  } finally {
    setLoading(loadPoolBtn, false, 'Scan');
  }
});

function renderPoolList(pools) {
  poolList.classList.remove('hidden');
  pools.forEach((p) => {
    const el = document.createElement('div');
    el.className = 'pool-item';
    el.innerHTML = `
      <div class="pool-item-name">${escHtml(p.name)}</div>
      <div class="pool-item-meta">${p.address.slice(0, 20)}… · ${p.positions.length} position(s) · ${p.totalSol.toFixed(4)} SOL</div>
    `;
    el.addEventListener('click', () => selectPool(p, el));
    poolList.appendChild(el);
  });
}

async function selectPool(pool, el) {
  document.querySelectorAll('.pool-item').forEach((i) => i.classList.remove('selected'));
  el.classList.add('selected');
  selectedPool = pool;
  poolInstance  = null;
  removeBtn.disabled = true;

  addLog(`Selected pool ${pool.address.slice(0, 12)}… — loading DLMM instance…`, 'info');

  try {
    poolInstance = await createPoolInstance(getConnection(), pool.address);

    posCount.textContent = pool.positions.length;
    posSol.textContent   = `${pool.totalSol.toFixed(6)} SOL`;
    posToken.textContent = formatAmt(pool.totalTokenRaw);
    positionBox.classList.remove('hidden');
    removeBtn.disabled = false;

    addLog(`Ready · ${pool.positions.length} position(s) · ${pool.totalSol.toFixed(4)} SOL`, 'success');
  } catch (e) {
    addLog(`Pool load error: ${e.message}`, 'error');
  }
}

// ── Direct pool address load ──────────────────────────────────────────────────
loadDirectBtn.addEventListener('click', async () => {
  const addr = poolAddrInput.value.trim();
  if (!addr) return;
  const keypair = getKeypair();
  if (!keypair) { addLog('Import a wallet first', 'warn'); return; }

  setLoading(loadDirectBtn, true, 'Loading…');
  poolList.innerHTML = '';
  poolList.classList.add('hidden');
  positionBox.classList.add('hidden');
  selectedPool = null;
  poolInstance  = null;
  removeBtn.disabled = true;

  try {
    addLog(`Loading positions for pool ${addr.slice(0, 12)}…`, 'info');
    const result = await loadPositionsDirect(getConnection(), addr, keypair.publicKey);

    if (result.positions.length === 0) {
      addLog('No positions found in this pool for your wallet', 'warn');
      return;
    }

    // Render as single item and auto-select it
    selectedPool = result;
    poolInstance = result.pool;

    posCount.textContent = result.positions.length;
    posSol.textContent   = `${result.totalSol.toFixed(6)} SOL`;
    posToken.textContent = formatAmt(result.totalTokenRaw);
    positionBox.classList.remove('hidden');
    removeBtn.disabled = false;

    addLog(`${result.positions.length} position(s) · ${result.totalSol.toFixed(4)} SOL in pool`, 'success');
  } catch (e) {
    addLog(`Error: ${e.message}`, 'error');
  } finally {
    setLoading(loadDirectBtn, false, 'Load');
  }
});

// ── All button ────────────────────────────────────────────────────────────────
$('all-btn').addEventListener('click', () => { amountInput.value = 'all'; });

// ── Remove liquidity ──────────────────────────────────────────────────────────
removeBtn.addEventListener('click', async () => {
  if (!selectedPool || !poolInstance) { addLog('Select a pool first', 'warn'); return; }
  const keypair = getKeypair();
  if (!keypair) { addLog('Import a wallet first', 'warn'); return; }

  const amtRaw = amountInput.value.trim();
  if (!amtRaw) { addLog('Enter an amount', 'warn'); return; }

  let bps;
  try {
    bps = parseBps(amtRaw, selectedPool.totalSol);
  } catch (e) {
    addLog(`Amount error: ${e.message}`, 'error');
    return;
  }

  const pctLabel = `${(bps / 100).toFixed(1)}%`;
  addLog(`Removing ${pctLabel} from ${selectedPool.name}…`, 'info');
  setLoading(removeBtn, true, `Removing ${pctLabel}…`);

  try {
    const txHashes = await removeLiquidity(
      getConnection(), poolInstance, selectedPool.positions, keypair, bps
    );

    for (const sig of txHashes) {
      const entry = document.createElement('div');
      entry.className = 'log-entry success';
      entry.innerHTML = `${ts()} TX confirmed · <a class="tx-link" href="https://solscan.io/tx/${sig}" target="_blank" rel="noopener">${sig.slice(0, 20)}…</a>`;
      log.prepend(entry);
    }

    addLog(`Done — ${txHashes.length} tx(s) confirmed`, 'success');
    await refreshBalance();

    // Refresh positions after removal
    const keypair2 = getKeypair();
    if (keypair2) {
      try {
        const refreshed = await loadPositionsDirect(getConnection(), selectedPool.address, keypair2.publicKey);
        selectedPool = refreshed;
        poolInstance = refreshed.pool;
        posCount.textContent = refreshed.positions.length;
        posSol.textContent   = `${refreshed.totalSol.toFixed(6)} SOL`;
        posToken.textContent = formatAmt(refreshed.totalTokenRaw);
        removeBtn.disabled   = refreshed.positions.length === 0;
        if (refreshed.positions.length === 0) addLog('Position fully closed', 'info');
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
function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
