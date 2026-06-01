import { Keypair, Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';

let _keypair = null;
let _connection = null;

export function importPrivateKey(input) {
  const trimmed = input.trim();
  let secretKey;

  // Accept JSON byte array [1,2,3,...] or base58 string
  if (trimmed.startsWith('[')) {
    const arr = JSON.parse(trimmed);
    secretKey = Uint8Array.from(arr);
  } else {
    secretKey = bs58.decode(trimmed);
  }

  _keypair = Keypair.fromSecretKey(secretKey);
  return _keypair.publicKey.toBase58();
}

export function getKeypair() {
  return _keypair;
}

export function clearKeypair() {
  _keypair = null;
}

export function isWalletLoaded() {
  return _keypair !== null;
}

export function setConnection(connection) {
  _connection = connection;
}

export function getConnection() {
  return _connection;
}

export function buildConnection(rpcProvider, heliusKey, customUrl) {
  let url;
  if (rpcProvider === 'helius') {
    if (!heliusKey) throw new Error('Helius API key required');
    url = `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`;
  } else if (rpcProvider === 'jupiter') {
    url = 'https://api.mainnet-beta.solana.com';
  } else {
    if (!customUrl) throw new Error('Custom RPC URL required');
    url = customUrl.trim();
  }
  return new Connection(url, 'confirmed');
}

export async function getSolBalance() {
  if (!_keypair || !_connection) return null;
  const lamports = await _connection.getBalance(_keypair.publicKey);
  return lamports / LAMPORTS_PER_SOL;
}
