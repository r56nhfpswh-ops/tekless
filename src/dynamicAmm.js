/**
 * Meteora Dynamic AMM — raw Solana only, no SDK.
 * Vault addresses are derived via PDA (matching the SDK approach) rather than
 * read from pool account bytes, which vary across pool versions.
 */
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
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
// Base key used in vault PDA seeds (from @meteora-ag/vault-sdk constants)
const VAULT_BASE_KEY      = new PublicKey('HWzXGcGHy4tcpYfaRDCyLNzXqBTv3E6BttpCH2vJxArv');

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const KNOWN_DECIMALS = {
  [WSOL_MINT]: 9,
  [USDC_MINT]: 6,
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 6,
};

// ── PDA derivation (mirrors @meteora-ag/vault-sdk getVaultPdas) ───────────────

function deriveVaultAddresses(tokenMint, poolPk) {
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), tokenMint.toBuffer(), VAULT_BASE_KEY.toBuffer()],
    VAULT_PROGRAM,
  );
  const [tokenVault] = PublicKey.findProgramAddressSync(
    [Buffer.from('token_vault'), vault.toBuffer()],
    VAULT_PROGRAM,
  );
  const [lpMint] = PublicKey.findProgramAddressSync(
    [Buffer.from('lp_mint'), vault.toBuffer()],
    VAULT_PROGRAM,
  );
  // Pool's share-of-vault LP token account: PDA([vault, pool], AMM_PROGRAM)
  const [vaultLp] = PublicKey.findProgramAddressSync(
    [vault.toBuffer(), poolPk.toBuffer()],
    DYNAMIC_AMM_PROGRAM,
  );
  return { vault, tokenVault, lpMint, vaultLp };
}

// ── Pool account parser (only the first three PublicKeys are needed) ──────────

function parsePool(data) {
  // Layout (Anchor): [0:8] discriminator, [8:40] lpMint, [40:72] tokenAMint, [72:104] tokenBMint
  let o = 8;
  const pk = () => { const k = new PublicKey(data.slice(o, o + 32)); o += 32; return k; };
  return { lpMint: pk(), tokenAMint: pk(), tokenBMint: pk() };
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

  const poolInfo = await connection.getAccountInfo(poolPk);
  if (!poolInfo) throw new Error('Pool account not found');
  const pool = parsePool(poolInfo.data);

  const aMintStr = pool.tokenAMint.toBase58();
  const bMintStr = pool.tokenBMint.toBase58();

  // Derive all vault-related addresses (no reading from pool bytes beyond the mints)
  const A = deriveVaultAddresses(pool.tokenAMint, poolPk);
  const B = deriveVaultAddresses(pool.tokenBMint, poolPk);

  // Fetch vault accounts to read totalAmount (offset 11, u64 LE)
  const [vaultAInfo, vaultBInfo] = await connection.getMultipleAccountsInfo([A.vault, B.vault]);
  if (!vaultAInfo || !vaultBInfo) throw new Error('Vault accounts not found');
  const vaultATotalAmount = new BN(vaultAInfo.data.slice(11, 19), 'le');
  const vaultBTotalAmount = new BN(vaultBInfo.data.slice(11, 19), 'le');

  // Pool LP supply + pool's share-of-vault LP balances + vault LP total supplies
  const [lpSupplyResp, vaultALpBal, vaultBLpBal, vaultALpSupplyResp, vaultBLpSupplyResp] =
    await Promise.all([
      connection.getTokenSupply(pool.lpMint),
      connection.getTokenAccountBalance(A.vaultLp),
      connection.getTokenAccountBalance(B.vaultLp),
      connection.getTokenSupply(A.lpMint),
      connection.getTokenSupply(B.lpMint),
    ]);

  const totalLpSupply  = new BN(lpSupplyResp.value.amount);
  const poolVaultALp   = new BN(vaultALpBal.value.amount);
  const poolVaultBLp   = new BN(vaultBLpBal.value.amount);
  const vaultALpSupply = new BN(vaultALpSupplyResp.value.amount);
  const vaultBLpSupply = new BN(vaultBLpSupplyResp.value.amount);

  const poolAmtA = vaultALpSupply.isZero() ? new BN(0)
    : vaultATotalAmount.mul(poolVaultALp).div(vaultALpSupply);
  const poolAmtB = vaultBLpSupply.isZero() ? new BN(0)
    : vaultBTotalAmount.mul(poolVaultBLp).div(vaultBLpSupply);

  // User LP balance
  const userLpAta = await getAssociatedTokenAddress(
    pool.lpMint, userPublicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  let lpBalance = new BN(0);
  try {
    const r = await connection.getTokenAccountBalance(userLpAta);
    lpBalance = new BN(r.value.amount);
  } catch { /* no ATA = zero */ }

  let rawA = 0, rawB = 0;
  if (!lpBalance.isZero() && !totalLpSupply.isZero()) {
    rawA = lpBalance.mul(poolAmtA).div(totalLpSupply).toNumber();
    rawB = lpBalance.mul(poolAmtB).div(totalLpSupply).toNumber();
  }

  const decimalsA = KNOWN_DECIMALS[aMintStr] ?? 6;
  const decimalsB = KNOWN_DECIMALS[bMintStr] ?? 6;

  return {
    poolAddress,
    pool,          // { lpMint, tokenAMint, tokenBMint }
    derived: { A, B },
    lpBalance, totalLpSupply,
    tokenAMintStr: aMintStr, tokenBMintStr: bMintStr,
    amountA: rawA / Math.pow(10, decimalsA),
    amountB: rawB / Math.pow(10, decimalsB),
    decimalsA, decimalsB,
    rawA, rawB,
    userLpAta,
  };
}

export async function removeDynamicAmmLiquidity(connection, poolData, keypair, bps) {
  const { poolAddress, pool, derived: { A, B }, lpBalance, userLpAta } = poolData;
  if (lpBalance.isZero()) throw new Error('No LP tokens to remove');

  const clampedBps = Math.min(Math.max(Math.round(bps), 1), 10000);
  const lpToRemove = lpBalance.muln(clampedBps).divn(10000);
  const poolPk     = new PublicKey(poolAddress);

  const userTokenAta = await getAssociatedTokenAddress(
    pool.tokenAMint, keypair.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const userTokenBta = await getAssociatedTokenAddress(
    pool.tokenBMint, keypair.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  const [ataAInfo, ataBInfo] = await connection.getMultipleAccountsInfo([userTokenAta, userTokenBta]);
  const preIxs  = [];
  const postIxs = [];

  if (!ataAInfo) preIxs.push(createAssociatedTokenAccountInstruction(
    keypair.publicKey, userTokenAta, keypair.publicKey, pool.tokenAMint,
  ));
  if (!ataBInfo) preIxs.push(createAssociatedTokenAccountInstruction(
    keypair.publicKey, userTokenBta, keypair.publicKey, pool.tokenBMint,
  ));

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
      { pubkey: A.vaultLp,         isMut: true,  isSigner: false },
      { pubkey: B.vaultLp,         isMut: true,  isSigner: false },
      { pubkey: A.vault,           isMut: true,  isSigner: false },
      { pubkey: B.vault,           isMut: true,  isSigner: false },
      { pubkey: A.lpMint,          isMut: true,  isSigner: false },
      { pubkey: B.lpMint,          isMut: true,  isSigner: false },
      { pubkey: A.tokenVault,      isMut: true,  isSigner: false },
      { pubkey: B.tokenVault,      isMut: true,  isSigner: false },
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

  const { amountA, amountB, tokenAMintStr, tokenBMintStr } = poolData;
  const isSOLA  = tokenAMintStr === WSOL_MINT, isSOLB  = tokenBMintStr === WSOL_MINT;
  const isUSDCA = tokenAMintStr === USDC_MINT, isUSDCB = tokenBMintStr === USDC_MINT;

  let quoteAmt = 0;
  if (isSOLA || isUSDCA)       quoteAmt = amountA;
  else if (isSOLB || isUSDCB)  quoteAmt = amountB;
  else                         quoteAmt = amountA;

  if (quoteAmt <= 0) throw new Error('No tokens in pool to calculate from');
  return Math.min(Math.round((n / quoteAmt) * 10000), 10000);
}
