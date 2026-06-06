import DLMM from '@meteora-ag/dlmm';
import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import BN from 'bn.js';

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

// Find all Meteora DLMM pools for a token using DexScreener (public, no auth)
export async function findPools(mintAddress) {
  const res = await fetch(
    `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`
  );
  if (!res.ok) throw new Error(`DexScreener error: ${res.status}`);

  const data = await res.json();
  const pools = [];

  for (const pair of data.pairs || []) {
    if (pair.chainId !== 'solana') continue;
    // Match any Meteora variant (meteora, meteora-dlmm, etc.)
    if (!pair.dexId?.toLowerCase().includes('meteora')) continue;

    const base = pair.baseToken?.address;
    const quote = pair.quoteToken?.address;
    const isSOLPair = base === WSOL_MINT || quote === WSOL_MINT;
    if (!isSOLPair) continue;

    pools.push({
      address: pair.pairAddress,
      name: `${pair.baseToken?.symbol || '?'}/${pair.quoteToken?.symbol || '?'}`,
      mintX: base,
      mintY: quote,
      liquidity: pair.liquidity?.usd || 0,
      isXSol: base === WSOL_MINT,
    });
  }

  if (pools.length === 0) throw new Error('No Meteora SOL pools found for this token');
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
