import DLMM from '@meteora-ag/dlmm';
import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import BN from 'bn.js';

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

// Find user's Meteora DLMM positions for a token — purely on-chain via user's RPC
export async function findUserPoolsForToken(connection, mintAddress, userPublicKey) {
  const positionsMap = await DLMM.getAllLbPairPositionsByUser(connection, userPublicKey);

  const results = [];

  for (const [poolAddress, poolData] of positionsMap) {
    const xMint = poolData.lbPair.tokenXMint.toBase58();
    const yMint = poolData.lbPair.tokenYMint.toBase58();

    const hasToken = xMint === mintAddress || yMint === mintAddress;
    const hasSOL   = xMint === WSOL_MINT   || yMint === WSOL_MINT;

    if (!hasToken || !hasSOL) continue;

    const isXSol = xMint === WSOL_MINT;
    let totalSolLamports = 0;
    let totalTokenRaw    = 0;

    for (const pos of poolData.lbPairPositionsData) {
      for (const bin of pos.positionData.positionBinData) {
        const xAmt = parseInt(bin.positionXAmount || '0', 10);
        const yAmt = parseInt(bin.positionYAmount || '0', 10);
        if (isXSol) {
          totalSolLamports += xAmt;
          totalTokenRaw    += yAmt;
        } else {
          totalSolLamports += yAmt;
          totalTokenRaw    += xAmt;
        }
      }
    }

    results.push({
      address: poolAddress,
      name: `${mintAddress.slice(0, 4)}…/SOL`,
      positions: poolData.lbPairPositionsData,
      totalSol: totalSolLamports / LAMPORTS_PER_SOL,
      totalTokenRaw,
      isXSol,
    });
  }

  return results;
}

// Create a DLMM pool instance (needed to call removeLiquidity)
export async function createPoolInstance(connection, poolAddress) {
  return DLMM.create(connection, new PublicKey(poolAddress));
}

// Remove liquidity from all positions at given basis points (1–10000)
export async function removeLiquidity(connection, pool, positions, keypair, bps) {
  if (positions.length === 0) throw new Error('No positions to remove');

  const clampedBps = Math.min(Math.max(Math.round(bps), 1), 10000);
  const shouldClose = clampedBps >= 10000;
  const txHashes = [];

  for (const position of positions) {
    const binIds = position.positionData.positionBinData.map((b) => b.binId);
    if (binIds.length === 0) continue;

    const txs = await pool.removeLiquidity({
      position: position.publicKey,
      user: keypair.publicKey,
      binIds,
      bpsToRemove: new BN(clampedBps),
      shouldClaimAndClose: shouldClose,
    });

    for (const tx of Array.isArray(txs) ? txs : [txs]) {
      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash     = blockhash;
      tx.lastValidBlockHeight = lastValidBlockHeight;
      tx.feePayer            = keypair.publicKey;
      tx.sign(keypair);

      const sig = await connection.sendRawTransaction(tx.serialize(), {
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

// Parse "0.5" / "1" / "all" into basis points
export function parseBps(input, totalSol) {
  const s = input.trim().toLowerCase();
  if (s === 'all') return 10000;

  const sol = parseFloat(s);
  if (isNaN(sol) || sol <= 0) throw new Error('Enter a SOL amount (e.g. 1, 0.5) or "all"');
  if (totalSol <= 0) throw new Error('No SOL in positions');

  return Math.min(Math.round((sol / totalSol) * 10000), 10000);
}
