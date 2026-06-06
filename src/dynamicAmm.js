import AmmImpl from '@meteora-ag/dynamic-amm-sdk';
import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import BN from 'bn.js';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

// Load a Dynamic AMM pool and get user's LP position
export async function loadDynamicAmmPool(connection, poolAddress, userPublicKey) {
  const pool = await AmmImpl.create(connection, new PublicKey(poolAddress));

  const aMint = pool.poolState.tokenAMint.toBase58();
  const bMint = pool.poolState.tokenBMint.toBase58();
  const isASOL = aMint === WSOL_MINT;

  // Get user's LP token balance
  const lpBalance = await pool.getUserBalance(userPublicKey);

  if (lpBalance.isZero()) {
    return { pool, lpBalance, totalSol: 0, totalTokenRaw: 0, isASOL, poolAddress };
  }

  // Quote a full withdrawal to show current SOL/token amounts
  const quote = pool.getWithdrawQuote(lpBalance, 0.5); // 0.5% slippage
  const solRaw  = isASOL ? quote.tokenAOutAmount : quote.tokenBOutAmount;
  const tokRaw  = isASOL ? quote.tokenBOutAmount : quote.tokenAOutAmount;

  return {
    pool,
    lpBalance,
    totalSol: solRaw.toNumber() / LAMPORTS_PER_SOL,
    totalTokenRaw: tokRaw.toNumber(),
    isASOL,
    poolAddress,
  };
}

// Remove liquidity from a Dynamic AMM pool
// bps: 1–10000 (basis points)
export async function removeDynamicAmmLiquidity(connection, poolData, keypair, bps) {
  const { pool, lpBalance, totalSol, isASOL } = poolData;

  if (lpBalance.isZero()) throw new Error('No LP tokens to remove');

  const clampedBps = Math.min(Math.max(Math.round(bps), 1), 10000);
  const lpToRemove = lpBalance.muln(clampedBps).divn(10000);

  // Get quote for this amount
  const quote = pool.getWithdrawQuote(lpToRemove, 0.5);

  const tx = await pool.withdraw(
    keypair.publicKey,
    lpToRemove,
    quote.minTokenAOutAmount,
    quote.minTokenBOutAmount
  );

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash      = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer             = keypair.publicKey;
  tx.sign(keypair);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
  });
  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    'confirmed'
  );

  return sig;
}

// Parse SOL amount or "all" to bps (same as DLMM version)
export function parseDynamicBps(input, totalSol) {
  const s = input.trim().toLowerCase();
  if (s === 'all') return 10000;
  const sol = parseFloat(s);
  if (isNaN(sol) || sol <= 0) throw new Error('Enter a SOL amount or "all"');
  if (totalSol <= 0) throw new Error('No SOL in pool');
  return Math.min(Math.round((sol / totalSol) * 10000), 10000);
}
