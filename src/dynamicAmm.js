/**
 * Meteora Dynamic AMM — raw implementation using only @solana/web3.js + @solana/spl-token.
 * No Meteora SDK. Parses pool/vault accounts directly from on-chain bytes.
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
const WSOL_MINT           = new PublicKey('So11111111111111111111111111111111111111112');

// ── Account parsers ───────────────────────────────────────────────────────────

function parsePool(data) {
  // 8-byte discriminator, then 7 PublicKeys in order
  let o = 8;
  const pk = () => { const k = new PublicKey(data.slice(o, o + 32)); o += 32; return k; };
  return {
    lpMint:    pk(), tokenAMint: pk(), tokenBMint: pk(),
    aVault:    pk(), bVault:     pk(),
    aVaultLp:  pk(), bVaultLp:   pk(),
  };
}

function parseVault(data) {
  // [0:8] disc, [8] enabled u8, [9:11] bumps (2×u8), [11:19] totalAmount u64,
  // [19:51] tokenVault, [51:83] feeVault, [83:115] tokenMint, [115:147] lpMint
  return {
    totalAmount: new BN(data.slice(11, 19), 'le'),
    tokenVault:  new PublicKey(data.slice(19, 51)),
    lpMint:      new PublicKey(data.slice(115, 147)),
  };
}

// ── Anchor discriminator via browser native crypto ────────────────────────────

async function disc(name) {
  const bytes = new TextEncoder().encode(`global:${name}`);
  const hash  = await crypto.subtle.digest('SHA-256', bytes);
  return Buffer.from(new Uint8Array(hash).slice(0, 8));
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function loadDynamicAmmPool(connection, poolAddress, userPublicKey) {
  const poolPk = new PublicKey(poolAddress);

  // 1. Fetch pool account
  const poolInfo = await connection.getAccountInfo(poolPk);
  if (!poolInfo) throw new Error('Pool account not found');
  const pool = parsePool(poolInfo.data);

  const isASOL = pool.tokenAMint.equals(WSOL_MINT);
  const isBSOL = pool.tokenBMint.equals(WSOL_MINT);
  if (!isASOL && !isBSOL) throw new Error('Pool does not contain SOL/WSOL');

  // 2. Fetch both vault accounts + vault LP mint supplies in one call
  const [vaultAInfo, vaultBInfo] = await connection.getMultipleAccountsInfo([
    pool.aVault, pool.bVault,
  ]);
  if (!vaultAInfo || !vaultBInfo) throw new Error('Vault accounts not found');

  const vaultA = parseVault(vaultAInfo.data);
  const vaultB = parseVault(vaultBInfo.data);

  // 3. Get pool's LP total supply + pool's vault LP balances (for accurate share calc)
  const [lpSupplyResp, poolVaultALpBalance, poolVaultBLpBalance] = await Promise.all([
    connection.getTokenSupply(pool.lpMint),
    connection.getTokenAccountBalance(pool.aVaultLp),
    connection.getTokenAccountBalance(pool.bVaultLp),
  ]);
  const totalLpSupply = new BN(lpSupplyResp.value.amount);

  // vault A supply (LP mint of vault A)
  const [vaultALpSupplyResp, vaultBLpSupplyResp] = await Promise.all([
    connection.getTokenSupply(vaultA.lpMint),
    connection.getTokenSupply(vaultB.lpMint),
  ]);
  const vaultALpSupply = new BN(vaultALpSupplyResp.value.amount);
  const vaultBLpSupply = new BN(vaultBLpSupplyResp.value.amount);

  // Pool's actual token amounts in vault
  const poolVaultALp = new BN(poolVaultALpBalance.value.amount);
  const poolVaultBLp = new BN(poolVaultBLpBalance.value.amount);

  const poolAmtA = vaultALpSupply.isZero() ? new BN(0)
    : vaultA.totalAmount.mul(poolVaultALp).div(vaultALpSupply);
  const poolAmtB = vaultBLpSupply.isZero() ? new BN(0)
    : vaultB.totalAmount.mul(poolVaultBLp).div(vaultBLpSupply);

  // 4. User's LP balance
  const userLpAta = await getAssociatedTokenAddress(
    pool.lpMint, userPublicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );
  let lpBalance = new BN(0);
  try {
    const balResp = await connection.getTokenAccountBalance(userLpAta);
    lpBalance = new BN(balResp.value.amount);
  } catch { /* ATA doesn't exist → zero balance */ }

  // 5. Calculate user's share
  let totalSol = 0;
  let totalTokenRaw = 0;
  if (!lpBalance.isZero() && !totalLpSupply.isZero()) {
    const solAmt   = isASOL ? poolAmtA : poolAmtB;
    const tokenAmt = isASOL ? poolAmtB : poolAmtA;
    totalSol      = lpBalance.mul(solAmt).div(totalLpSupply).toNumber() / LAMPORTS_PER_SOL;
    totalTokenRaw = lpBalance.mul(tokenAmt).div(totalLpSupply).toNumber();
  }

  return {
    poolAddress, pool, vaultA, vaultB,
    lpBalance, totalLpSupply,
    totalSol, totalTokenRaw, isASOL, userLpAta,
  };
}

export async function removeDynamicAmmLiquidity(connection, poolData, keypair, bps) {
  const { poolAddress, pool, vaultA, vaultB, lpBalance, isASOL, userLpAta } = poolData;
  if (lpBalance.isZero()) throw new Error('No LP tokens to remove');

  const clampedBps  = Math.min(Math.max(Math.round(bps), 1), 10000);
  const lpToRemove  = lpBalance.muln(clampedBps).divn(10000);
  const poolPk      = new PublicKey(poolAddress);

  // User's token A and B ATAs
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

  // Auto-unwrap WSOL after withdrawal
  const wsolAta = pool.tokenAMint.equals(WSOL_MINT) ? userTokenAta : userTokenBta;
  postIxs.push(createCloseAccountInstruction(wsolAta, keypair.publicKey, keypair.publicKey));

  // Build removeBalanceLiquidity instruction data
  const ixDisc = await disc('remove_balance_liquidity');
  const args   = Buffer.alloc(24);
  lpToRemove.toArrayLike(Buffer, 'le', 8).copy(args, 0);
  // minimumATokenOut = 0, minimumBTokenOut = 0 (accept any amount)
  new BN(0).toArrayLike(Buffer, 'le', 8).copy(args, 8);
  new BN(0).toArrayLike(Buffer, 'le', 8).copy(args, 16);

  const removeIx = new TransactionInstruction({
    programId: DYNAMIC_AMM_PROGRAM,
    data: Buffer.concat([ixDisc, args]),
    keys: [
      { pubkey: poolPk,              isMut: true,  isSigner: false },
      { pubkey: pool.lpMint,         isMut: true,  isSigner: false },
      { pubkey: userLpAta,           isMut: true,  isSigner: false },
      { pubkey: pool.aVaultLp,       isMut: true,  isSigner: false },
      { pubkey: pool.bVaultLp,       isMut: true,  isSigner: false },
      { pubkey: pool.aVault,         isMut: true,  isSigner: false },
      { pubkey: pool.bVault,         isMut: true,  isSigner: false },
      { pubkey: vaultA.lpMint,       isMut: true,  isSigner: false },
      { pubkey: vaultB.lpMint,       isMut: true,  isSigner: false },
      { pubkey: vaultA.tokenVault,   isMut: true,  isSigner: false },
      { pubkey: vaultB.tokenVault,   isMut: true,  isSigner: false },
      { pubkey: userTokenAta,        isMut: true,  isSigner: false },
      { pubkey: userTokenBta,        isMut: true,  isSigner: false },
      { pubkey: keypair.publicKey,   isMut: false, isSigner: true  },
      { pubkey: VAULT_PROGRAM,       isMut: false, isSigner: false },
      { pubkey: TOKEN_PROGRAM_ID,    isMut: false, isSigner: false },
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

export function parseDynamicBps(input, totalSol) {
  const s = input.trim().toLowerCase();
  if (s === 'all') return 10000;
  const sol = parseFloat(s);
  if (isNaN(sol) || sol <= 0) throw new Error('Enter a SOL amount or "all"');
  if (totalSol <= 0) throw new Error('No SOL in pool');
  return Math.min(Math.round((sol / totalSol) * 10000), 10000);
}
