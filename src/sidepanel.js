import './styles.css';
import {
  importPrivateKey,
  getKeypair,
  clearKeypair,
  buildConnection,
  setConnection,
  getConnection,
  getSolBalance,
} from './wallet.js';
import {
  findPools,
  loadUserPositions,
  removeLiquidity,
  parseBps,
} from './meteora.js';

// ── State ───────────────────────────────────────────────────────────────────
let selectedPool = null;     // pool metadata from findPools()
let loadedPool = null;       // { pool, userPositions, totalSol, totalTokenRaw }
let rpcConnected = false;

// ── DOM refs ─────────────────────────────────────────────────────────────────
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

const mintInput    = $('mint-input');
const loadPoolBtn  = $('load-pool-btn');
const poolList     = $('pool-list');
const positionBox  = $('position-box');
const posCount     = $('pos-count');
const posSol       = $('pos-sol');
const posToken     = $('pos-token');

const amountInput  = $('amount-input');
const removeBtn    = $('remove-btn');
const log          = $('log');

// ── RPC tab state ────────────────────────────────────────────────────────────
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

// ── Logging ──────────────────────────────────────────────────────────────────
function addLog(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `log-entry ${type}`;
  el.textContent = `${timestamp()} ${msg}`;
  log.prepend(el);
}

function timestamp() {
  return new Date().toTimeString().slice(0, 8);
}

function setLoading(btn, loading, label) {
  if (loading) {
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span>${label}`;
  } else {
    btn.disabled = false;
    btn.textContent = label;
  }
}

// ── Wallet import ─────────────────────────────────────────────────────────────
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

    // Fetch balance if RPC ready
    if (rpcConnected) await refreshBalance();
  } catch (e) {
    addLog(`Wallet error: ${e.message}`, 'error');
  }
});

// ── RPC connect ───────────────────────────────────────────────────────────────
connectRpc.addEventListener('click', async () => {
  setLoading(connectRpc, true, 'Connecting…');
  rpcStatusRow.classList.add('hidden');

  try {
    const conn = buildConnection(
      activeRpc,
      heliusKey.value,
      customUrl.value
    );

    // Verify connection
    const slot = await conn.getSlot();
    setConnection(conn);
    rpcConnected = true;

    rpcDot.className = 'status-dot ok';
    rpcStatusTxt.textContent = `Connected · slot ${slot.toLocaleString()}`;
    rpcStatusRow.classList.remove('hidden');

    loadPoolBtn.disabled = false;
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
    if (bal !== null) {
      solBalance.innerHTML = `Balance: <span>${bal.toFixed(4)} SOL</span>`;
    }
  } catch {}
}

// ── Pool loading ──────────────────────────────────────────────────────────────
loadPoolBtn.addEventListener('click', async () => {
  const mint = mintInput.value.trim();
  if (!mint) return;

  setLoading(loadPoolBtn, true, 'Searching…');
  poolList.innerHTML = '';
  poolList.classList.add('hidden');
  positionBox.classList.add('hidden');
  selectedPool = null;
  loadedPool = null;
  removeBtn.disabled = true;

  try {
    const pools = await findPools(mint);
    if (pools.length === 0) {
      addLog('No SOL/TOKEN Meteora pools found for this mint', 'warn');
      return;
    }

    addLog(`Found ${pools.length} pool(s) for this token`, 'info');
    renderPoolList(pools);
  } catch (e) {
    addLog(`Pool search error: ${e.message}`, 'error');
  } finally {
    setLoading(loadPoolBtn, false, 'Load');
  }
});

function renderPoolList(pools) {
  poolList.innerHTML = '';
  poolList.classList.remove('hidden');

  pools.forEach((p) => {
    const el = document.createElement('div');
    el.className = 'pool-item';
    el.innerHTML = `
      <div class="pool-item-name">${escHtml(p.name)}</div>
      <div class="pool-item-meta">${p.address.slice(0, 20)}… · $${p.liquidity.toFixed(0)} TVL</div>
    `;
    el.addEventListener('click', () => selectPool(p, el));
    poolList.appendChild(el);
  });
}

async function selectPool(pool, el) {
  document.querySelectorAll('.pool-item').forEach((i) => i.classList.remove('selected'));
  el.classList.add('selected');
  selectedPool = pool;
  loadedPool = null;
  removeBtn.disabled = true;
  positionBox.classList.add('hidden');

  addLog(`Loading positions for ${pool.name}…`, 'info');

  const keypair = getKeypair();
  if (!keypair) {
    addLog('Import a wallet first', 'warn');
    return;
  }

  try {
    const result = await loadUserPositions(
      getConnection(),
      pool.address,
      keypair.publicKey
    );

    loadedPool = result;

    const { userPositions, totalSol, totalTokenRaw } = result;

    posCount.textContent = userPositions.length;
    posSol.textContent = `${totalSol.toFixed(6)} SOL`;
    posToken.textContent = formatRawAmount(totalTokenRaw);
    positionBox.classList.remove('hidden');

    if (userPositions.length > 0) {
      removeBtn.disabled = false;
      addLog(
        `${userPositions.length} position(s) found · ${totalSol.toFixed(4)} SOL in pool`,
        'success'
      );
    } else {
      addLog('No active positions in this pool', 'warn');
    }
  } catch (e) {
    addLog(`Position load error: ${e.message}`, 'error');
  }
}

// ── All button ────────────────────────────────────────────────────────────────
$('all-btn').addEventListener('click', () => {
  amountInput.value = 'all';
});

// ── Remove liquidity ──────────────────────────────────────────────────────────
removeBtn.addEventListener('click', async () => {
  if (!loadedPool || !selectedPool) {
    addLog('Load a pool first', 'warn');
    return;
  }

  const keypair = getKeypair();
  if (!keypair) {
    addLog('Import a wallet first', 'warn');
    return;
  }

  const amtRaw = amountInput.value.trim();
  if (!amtRaw) {
    addLog('Enter an amount to remove', 'warn');
    return;
  }

  let bps;
  try {
    bps = parseBps(amtRaw, loadedPool.totalSol);
  } catch (e) {
    addLog(`Amount error: ${e.message}`, 'error');
    return;
  }

  const pctLabel = `${(bps / 100).toFixed(1)}%`;
  addLog(`Removing ${pctLabel} of liquidity from ${selectedPool.name}…`, 'info');

  setLoading(removeBtn, true, `Removing ${pctLabel}…`);
  removeBtn.disabled = true;

  try {
    const txHashes = await removeLiquidity(
      getConnection(),
      loadedPool.pool,
      loadedPool.userPositions,
      keypair,
      bps
    );

    for (const sig of txHashes) {
      const explorerUrl = `https://solscan.io/tx/${sig}`;
      const entry = document.createElement('div');
      entry.className = 'log-entry success';
      entry.innerHTML = `${timestamp()} TX confirmed · <a class="tx-link" href="${escHtml(explorerUrl)}" target="_blank" rel="noopener">${sig.slice(0, 20)}…</a>`;
      log.prepend(entry);
    }

    addLog(`Done. ${txHashes.length} transaction(s) sent.`, 'success');

    // Reload positions
    await refreshBalance();
    const updated = await loadUserPositions(
      getConnection(),
      selectedPool.address,
      keypair.publicKey
    );
    loadedPool = updated;
    posCount.textContent = updated.userPositions.length;
    posSol.textContent = `${updated.totalSol.toFixed(6)} SOL`;
    posToken.textContent = formatRawAmount(updated.totalTokenRaw);

    if (updated.userPositions.length === 0) {
      removeBtn.disabled = true;
    }
  } catch (e) {
    addLog(`Remove error: ${e.message}`, 'error');
  } finally {
    removeBtn.disabled = !loadedPool || loadedPool.userPositions.length === 0;
    removeBtn.textContent = 'Remove Liquidity';
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatRawAmount(raw) {
  // Show with up to 6 significant digits
  if (raw >= 1_000_000) return (raw / 1_000_000).toFixed(4) + 'M';
  if (raw >= 1_000) return (raw / 1_000).toFixed(4) + 'K';
  return raw.toLocaleString();
}

function escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
