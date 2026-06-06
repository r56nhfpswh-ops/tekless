/**
 * Meteora Dynamic AMM — raw Solana only, no SDK.
 * Supports any token pair: SOL, USDC, or anything else.
 */
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddress,
} from '@solana/spl-token';
import BN from 'bn.js';

const DYNAMIC_AMM_PROGRAM = new PublicKey('Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB');
const VAULT_PROGRAM       = new PublicKey('24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi');
export const WSOL_MINT    = 'So11111111111111111111111111111111111111112';
export const USDC_MINT    = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Known decimals for common quote tokens; fallback to 6
const KNOWN_DECIMALS = {
  [WSOL_MINT]: 9,
  [USDC_MINT]: 6,
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 6,  // USDT
};

// ── Account parsers ───────────────────────────────────────────────────────────

function parsePool(data) {
  let o = 8; // skip 8-byte discriminator
  const pk = () => { const k = new PublicKey(data.slice(o, o + 32)); o += 32; return k; };
  return {
    lpMint:     pk(), tokenAMint: pk(), tokenBMint: pk(),
    aVault:     pk(), bVault:     pk(),
    aVaultLp:   pk(), bVaultLp:   pk(),
  };
}

function parseVault(data) {
  // [0:8] disc, [8] enabled, [9:11] bumps (2×u8), [11:19] totalAmount u64,
  // [19:51] tokenVault, [51:83] feeVault, [83:115] tokenMint, [115:147] lpMint
  return {
    totalAmount: new BN(data.slice(11, 19), 'le'),
    tokenVault:  new PublicKey(data.slice(19, 51)),
    lpMint:      new PublicKey(data.slice(115, 147)),
  };
}

// ── Anchor discriminator (browser native crypto) ──────────────────────────────

async function disc(name) {
  const bytes = new TextEncoder().encode(`global:${name}`);
  const hash  = await crypto.subtle.digest('SHA-256', bytes);
  return Buffer.from(new Uint8Array(hash).slice(0, 8));
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function loadDynamicAmmPool(connection, poolAddress, userPublicKey) {
  const poolPk = new PublicKey(poolAddress);

  // Fetch pool account
  const poolInfo = await connection.getAccountInfo(poolPk);
  if (!poolInfo) throw new Error('Pool account not found');
  const pool = parsePool(poolInfo.data);

  const aMintStr = pool.tokenAMint.toBase58();
  const bMintStr = pool.tokenBMint.toBase58();

  // Fetch vault accounts
  const [vaultAInfo, vaultBInfo] = await connection.getMultipleAccountsInfo([pool.aVault, pool.bVault]);
  if (!vaultAInfo || !vaultBInfo) throw new Error('Vault accounts not found');
  const vaultA = parseVault(vaultAInfo.data);
  const vaultB = parseVault(vaultBInfo.data);

  // Pool LP supply + pool's vault LP balances
  const [lpSupplyResp, poolVaultALpBal, poolVaultBLpBal] = await Promise.all([
    connection.getTokenSupply(pool.lpMint),
    connection.getTokenAccountBalance(pool.aVaultLp),
    connection.getTokenAccountBalance(pool.bVaultLp),
  ]);
  const totalLpSupply = new BN(lpSupplyResp.value.amount);

  // Vault LP supplies
  const [vaultALpSupplyResp, vaultBLpSupplyResp] = await Promise.all([
    connection.getTokenSupply(vaultA.lpMint),
    connection.getTokenSupply(vaultB.lpMint),
  ]);
  const vaultALpSupply = new BN(vaultALpSupplyResp.value.amount);
  const vaultBLpSupply = new BN(vaultBLpSupplyResp.value.amount);

  // Pool's actual token amounts in each vault
  const poolVaultALp = new BN(poolVaultALpBal.value.amount);
  const poolVaultBLp = new BN(poolVaultBLpBal.value.amount);
  const poolAmtA = vaultALpSupply.isZero() ? new BN(0)
    : vaultA.totalAmount.mul(poolVaultALp).div(vaultALpSupply);
  const poolAmtB = vaultBLpSupply.isZero() ? new BN(0)
    : vaultB.totalAmount.mul(poolVaultBLp).div(vaultBLpSupply);

  // User LP balance
  const userLpAta = await getAssociatedTokenAddress(
    pool.lpMint, userPublicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );
  let lpBalance = new BN(0);
  try {
    const r = await connection.getTokenAccountBalance(userLpAta);
    lpBalance = new BN(r.value.amount);
  } catch { /* no ATA = zero */ }

  // User's share of each token (raw lamports/smallest unit)
  let rawA = 0, rawB = 0;
  if (!lpBalance.isZero() && !totalLpSupply.isZero()) {
    rawA = lpBalance.mul(poolAmtA).div(totalLpSupply).toNumber();
    rawB = lpBalance.mul(poolAmtB).div(totalLpSupply).toNumber();
  }

  const decimalsA = KNOWN_DECIMALS[aMintStr] ?? 6;
  const decimalsB = KNOWN_DECIMALS[bMintStr] ?? 6;

  return {
    poolAddress, pool, vaultA, vaultB, lpBalance, totalLpSupply,
    tokenAMintStr: aMintStr, tokenBMintStr: bMintStr,
    amountA: rawA / Math.pow(10, decimalsA),
    amountB: rawB / Math.pow(10, decimalsB),
    decimalsA, decimalsB,
    rawA, rawB,
    userLpAta,
  };
}

export async function removeDynamicAmmLiquidity(connection, poolData, keypair, bps) {
  const { poolAddress, pool, vaultA, vaultB, lpBalance, userLpAta } = poolData;
  if (lpBalance.isZero()) throw new Error('No LP tokens to remove');

  const clampedBps = Math.min(Math.max(Math.round(bps), 1), 10000);
  const lpToRemove = lpBalance.muln(clampedBps).divn(10000);
  const poolPk     = new PublicKey(poolAddress);

  const userTokenAta = await getAssociatedTokenAddress(
    pool.tokenAMint, keypair.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const userTokenBta = await getAssociatedTokenAddress(
    pool.tokenBMint, keypair.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const [ataAInfo, ataBInfo] = await connection.getMultipleAccountsInfo([userTokenAta, userTokenBta]);
  const preIxs  = [];
  const postIxs = [];

  if (!ataAInfo) preIxs.push(createAssociatedTokenAccountInstruction(
    keypair.publicKey, userTokenAta, keypair.publicKey, pool.tokenAMint
  ));
  if (!ataBInfo) preIxs.push(createAssociatedTokenAccountInstruction(
    keypair.publicKey, userTokenBta, keypair.publicKey, pool.tokenBMint
  ));

  // Unwrap WSOL if present
  if (pool.tokenAMint.toBase58() === WSOL_MINT) {
    postIxs.push(createCloseAccountInstruction(userTokenAta, keypair.publicKey, keypair.publicKey));
  } else if (pool.tokenBMint.toBase58() === WSOL_MINT) {
    postIxs.push(createCloseAccountInstruction(userTokenBta, keypair.publicKey, keypair.publicKey));
  }

  const ixDisc = await disc('remove_balance_liquidity');
  const args   = Buffer.alloc(24);
  lpToRemove.toArrayLike(Buffer, 'le', 8).copy(args, 0);
  new BN(0).toArrayLike(Buffer, 'le', 8).copy(args, 8);
  new BN(0).toArrayLike(Buffer, 'le', 8).copy(args, 16);

  const removeIx = new TransactionInstruction({
    programId: DYNAMIC_AMM_PROGRAM,
    data: Buffer.concat([ixDisc, args]),
    keys: [
      { pubkey: poolPk,            isMut: true,  isSigner: false },
      { pubkey: pool.lpMint,       isMut: true,  isSigner: false },
      { pubkey: userLpAta,         isMut: true,  isSigner: false },
      { pubkey: pool.aVaultLp,     isMut: true,  isSigner: false },
      { pubkey: pool.bVaultLp,     isMut: true,  isSigner: false },
      { pubkey: pool.aVault,       isMut: true,  isSigner: false },
      { pubkey: pool.bVault,       isMut: true,  isSigner: false },
      { pubkey: vaultA.lpMint,     isMut: true,  isSigner: false },
      { pubkey: vaultB.lpMint,     isMut: true,  isSigner: false },
      { pubkey: vaultA.tokenVault, isMut: true,  isSigner: false },
      { pubkey: vaultB.tokenVault, isMut: true,  isSigner: false },
      { pubkey: userTokenAta,      isMut: true,  isSigner: false },
      { pubkey: userTokenBta,      isMut: true,  isSigner: false },
      { pubkey: keypair.publicKey, isMut: false, isSigner: true  },
      { pubkey: VAULT_PROGRAM,     isMut: false, isSigner: false },
      { pubkey: TOKEN_PROGRAM_ID,  isMut: false, isSigner: false },
    ],
  });

  const tx = new Transaction();
  preIxs.forEach(ix => tx.add(ix));
  tx.add(removeIx);
  postIxs.forEach(ix => tx.add(ix));

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash      = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer             = keypair.publicKey;
  tx.sign(keypair);

  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  return sig;
}

// Parse input to bps — supports "all", "50%", or a token amount vs amountA/B
export function parseDynamicBps(input, poolData) {
  const s = input.trim().toLowerCase();
  if (s === 'all') return 10000;

  if (s.endsWith('%')) {
    const pct = parseFloat(s);
    if (isNaN(pct) || pct <= 0) throw new Error('Invalid percentage');
    return Math.min(Math.round(pct * 100), 10000);
  }

  const n = parseFloat(s);
  if (isNaN(n) || n <= 0) throw new Error('Enter an amount, % or "all"');

  // Try to match against whichever token makes sense
  const { amountA, amountB, tokenAMintStr, tokenBMintStr } = poolData;
  const isSOLA = tokenAMintStr === WSOL_MINT, isSOLB = tokenBMintStr === WSOL_MINT;
  const isUSDCA = tokenAMintStr === USDC_MINT, isUSDCB = tokenBMintStr === USDC_MINT;

  let quoteAmt = 0;
  if (isSOLA || isUSDCA) quoteAmt = amountA;
  else if (isSOLB || isUSDCB) quoteAmt = amountB;
  else quoteAmt = amountA; // fallback: treat token A as quote

  if (quoteAmt <= 0) throw new Error('No tokens in pool to calculate from');
  return Math.min(Math.round((n / quoteAmt) * 10000), 10000);
}
