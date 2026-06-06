import DLMM from '@meteora-ag/dlmm';
import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import BN from 'bn.js';

const METEORA_API = 'https://dlmm-api.meteora.ag';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

// Find all Meteora DLMM pools containing the given mint (paired with SOL)
export async function findPools(mintAddress) {
  // Try search_term param first, fall back to fetching all and filtering
  let data = null;

  const attempts = [
    `${METEORA_API}/pair/all_by_groups?search_term=${mintAddress}&sort_key=liquidity&order_by=desc&offset=0&limit=50`,
    `${METEORA_API}/pair/all_by_groups?token=${mintAddress}`,
    `${METEORA_API}/pair/all?search_term=${mintAddress}&sort_key=liquidity&order_by=desc&offset=0&limit=50&include_unknown=true`,
  ];

  for (const url of attempts) {
    const res = await fetch(url);
    if (res.ok) { data = await res.json(); break; }
  }

  if (!data) throw new Error('Could not reach Meteora API. Check your RPC/network.');

  // API returns either { groups: [...] } or a flat array of pairs
  const rawPairs = Array.isArray(data)
    ? data
    : (data.groups || []).flatMap((g) => g.pairs || []);

  const pools = [];
  for (const pair of rawPairs) {
    const isSOLPair = pair.mint_x === WSOL_MINT || pair.mint_y === WSOL_MINT;
    // Also match if either mint matches the user's token
    const hasToken = pair.mint_x === mintAddress || pair.mint_y === mintAddress;
    if (isSOLPair && hasToken) {
      pools.push({
        address: pair.address,
        name: pair.name,
        mintX: pair.mint_x,
        mintY: pair.mint_y,
        liquidity: parseFloat(pair.liquidity) || 0,
        fees24h: parseFloat(pair.fees) || 0,
        isXSol: pair.mint_x === WSOL_MINT,
      });
    }
  }

  // Highest liquidity first
  return pools.sort((a, b) => b.liquidity - a.liquidity);
}

// Load DLMM pool and get user positions with SOL/token totals
export async function loadUserPositions(connection, poolAddress, userPublicKey) {
  const pool = await DLMM.create(connection, new PublicKey(poolAddress));
  const { userPositions } = await pool.getPositionsByUserAndLbPair(
    userPublicKey
  );

  // Determine which side is SOL
  const isXSol =
    pool.tokenX.publicKey.toBase58() === WSOL_MINT;

  let totalSolLamports = 0;
  let totalTokenRaw = 0;

  for (const pos of userPositions) {
    for (const bin of pos.positionData.positionBinData) {
      const xAmt = parseInt(bin.positionXAmount || '0', 10);
      const yAmt = parseInt(bin.positionYAmount || '0', 10);
      if (isXSol) {
        totalSolLamports += xAmt;
        totalTokenRaw += yAmt;
      } else {
        totalSolLamports += yAmt;
        totalTokenRaw += xAmt;
      }
    }
  }

  return {
    pool,
    userPositions,
    totalSol: totalSolLamports / LAMPORTS_PER_SOL,
    totalTokenRaw,
    isXSol,
  };
}

// Remove liquidity from all user positions at the given basis points (0–10000)
export async function removeLiquidity(
  connection,
  pool,
  userPositions,
  keypair,
  bps
) {
  if (userPositions.length === 0) throw new Error('No positions to remove');

  const clampedBps = Math.min(Math.max(Math.round(bps), 1), 10000);
  const shouldClose = clampedBps >= 10000;
  const txHashes = [];

  for (const position of userPositions) {
    const binIds = position.positionData.positionBinData.map((b) => b.binId);
    if (binIds.length === 0) continue;

    const txs = await pool.removeLiquidity({
      position: position.publicKey,
      user: keypair.publicKey,
      binIds,
      bpsToRemove: new BN(clampedBps),
      shouldClaimAndClose: shouldClose,
    });

    const txArray = Array.isArray(txs) ? txs : [txs];

    for (const tx of txArray) {
      // Set recent blockhash and sign
      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
      tx.lastValidBlockHeight = lastValidBlockHeight;
      tx.feePayer = keypair.publicKey;
      tx.sign(keypair);

      const raw = tx.serialize();
      const sig = await connection.sendRawTransaction(raw, {
        skipPreflight: false,
      });
      await connection.confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight },
        'confirmed'
      );
      txHashes.push(sig);
    }
  }

  return txHashes;
}

// Parse user input into basis points
// Accepts: "all" → 100%, or a SOL number like "1", "0.5", "2.5"
export function parseBps(input, totalSol) {
  const s = input.trim().toLowerCase();

  if (s === 'all') return 10000;

  const sol = parseFloat(s);
  if (isNaN(sol) || sol <= 0) throw new Error('Enter a SOL amount (e.g. 1, 0.5) or "all"');
  if (totalSol <= 0) throw new Error('No SOL in positions');

  const bps = Math.round((sol / totalSol) * 10000);
  return Math.min(bps, 10000);
}
