/**
 * Soroban RPC getLedgerEntries key builder / decoder (ISSUE-227 / #328).
 * Pure offline utility built on the Stellar SDK XDR types.
 */

import { Address, Asset, StrKey, xdr } from '@stellar/stellar-sdk';

export const SUPPORTED_KEY_TYPES = [
  'account',
  'trustline',
  'offer',
  'data',
  'claimable-balance',
  'liquidity-pool',
  'contract-data',
  'contract-code',
] as const;
export type KeyType = (typeof SUPPORTED_KEY_TYPES)[number];

export interface KeyInput {
  type: string;
  account?: string;
  asset?: string; // "native" or CODE:ISSUER
  offerId?: string;
  dataName?: string;
  balanceId?: string; // 72 hex chars (type prefix + hash) or 64 hex chars (v0 hash)
  poolId?: string; // 64 hex chars
  contract?: string;
  key?: string; // ScVal XDR base64 for contract-data
  durability?: string; // persistent | temporary
  wasmHash?: string; // 64 hex chars
}

function need(v: string | undefined, name: string, type: string): string {
  if (!v) throw new Error(`Missing required field "${name}" for key type "${type}"`);
  return v;
}

function accountId(v: string | undefined, type: string): string {
  const a = need(v, 'account', type);
  if (!StrKey.isValidEd25519PublicKey(a)) throw new Error(`Invalid account ID: ${a}`);
  return a;
}

function hex32(v: string | undefined, name: string, type: string): Buffer {
  const h = need(v, name, type);
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new Error(`"${name}" must be 64 hex characters`);
  return Buffer.from(h, 'hex');
}

function parseAsset(v: string | undefined, type: string): Asset {
  const a = need(v, 'asset', type);
  if (a.toLowerCase() === 'native') return Asset.native();
  const [code, issuer] = a.split(':');
  if (!code || !issuer) throw new Error('Asset must be "native" or "CODE:ISSUER"');
  if (!StrKey.isValidEd25519PublicKey(issuer)) throw new Error(`Invalid asset issuer: ${issuer}`);
  return new Asset(code, issuer);
}

export function buildLedgerKey(input: KeyInput): xdr.LedgerKey {
  const t = input.type;
  switch (t) {
    case 'account':
      return xdr.LedgerKey.account(
        new xdr.LedgerKeyAccount({ accountId: xdr.PublicKey.publicKeyTypeEd25519(StrKey.decodeEd25519PublicKey(accountId(input.account, t))) }),
      );
    case 'trustline': {
      const asset = parseAsset(input.asset, t);
      if (asset.isNative()) throw new Error('Trustline keys cannot use the native asset');
      return xdr.LedgerKey.trustline(
        new xdr.LedgerKeyTrustLine({
          accountId: xdr.PublicKey.publicKeyTypeEd25519(StrKey.decodeEd25519PublicKey(accountId(input.account, t))),
          asset: asset.toTrustLineXDRObject(),
        }),
      );
    }
    case 'offer': {
      const id = need(input.offerId, 'offerId', t);
      if (!/^\d+$/.test(id)) throw new Error('"offerId" must be a non-negative integer');
      return xdr.LedgerKey.offer(
        new xdr.LedgerKeyOffer({
          sellerId: xdr.PublicKey.publicKeyTypeEd25519(StrKey.decodeEd25519PublicKey(accountId(input.account, t))),
          offerId: xdr.Int64.fromString(id),
        }),
      );
    }
    case 'data': {
      const name = need(input.dataName, 'dataName', t);
      if (Buffer.byteLength(name) > 64) throw new Error('"dataName" must be at most 64 bytes');
      return xdr.LedgerKey.data(
        new xdr.LedgerKeyData({
          accountId: xdr.PublicKey.publicKeyTypeEd25519(StrKey.decodeEd25519PublicKey(accountId(input.account, t))),
          dataName: name,
        }),
      );
    }
    case 'claimable-balance': {
      const raw = need(input.balanceId, 'balanceId', t);
      const h = raw.length === 72 ? raw.slice(8) : raw;
      return xdr.LedgerKey.claimableBalance(
        new xdr.LedgerKeyClaimableBalance({ balanceId: xdr.ClaimableBalanceId.claimableBalanceIdTypeV0(hex32(h, 'balanceId', t)) }),
      );
    }
    case 'liquidity-pool':
      return xdr.LedgerKey.liquidityPool(new xdr.LedgerKeyLiquidityPool({ liquidityPoolId: hex32(input.poolId, 'poolId', t) }));
    case 'contract-data': {
      const contract = need(input.contract, 'contract', t);
      if (!StrKey.isValidContract(contract)) throw new Error(`Invalid contract ID: ${contract}`);
      const durability = (input.durability ?? 'persistent').toLowerCase();
      if (durability !== 'persistent' && durability !== 'temporary') throw new Error('"durability" must be persistent or temporary');
      let key: xdr.ScVal;
      try {
        key = input.key ? xdr.ScVal.fromXDR(input.key, 'base64') : xdr.ScVal.scvLedgerKeyContractInstance();
      } catch {
        throw new Error('"key" is not a valid base64 ScVal XDR');
      }
      return xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: Address.fromString(contract).toScAddress(),
          key,
          durability: durability === 'temporary' ? xdr.ContractDataDurability.temporary() : xdr.ContractDataDurability.persistent(),
        }),
      );
    }
    case 'contract-code':
      return xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: hex32(input.wasmHash, 'wasmHash', t) }));
    default:
      throw new Error(`Unsupported key type "${t}". Supported: ${SUPPORTED_KEY_TYPES.join(', ')}`);
  }
}

export function encodeLedgerKey(input: KeyInput): string {
  return buildLedgerKey(input).toXDR('base64');
}

export interface DecodedKey {
  type: string;
  fields: Record<string, string>;
}

const pk = (p: xdr.PublicKey) => StrKey.encodeEd25519PublicKey(p.ed25519());

export function decodeLedgerKey(base64: string): DecodedKey {
  let k: xdr.LedgerKey;
  try {
    k = xdr.LedgerKey.fromXDR(base64.trim(), 'base64');
  } catch {
    throw new Error('Malformed ledger key XDR: could not decode as LedgerKey');
  }
  switch (k.switch().name) {
    case 'account':
      return { type: 'account', fields: { account: pk(k.account().accountId()) } };
    case 'trustline': {
      const tl = k.trustLine();
      const asset = tl.asset();
      let a: string;
      if (asset.switch().name === 'assetTypePoolShare') a = `pool:${asset.liquidityPoolId().liquidityPoolId().toString('hex')}`;
      else a = Asset.fromOperation(xdr.Asset.fromXDR(asset.toXDR())).toString();
      return { type: 'trustline', fields: { account: pk(tl.accountId()), asset: a } };
    }
    case 'offer':
      return { type: 'offer', fields: { account: pk(k.offer().sellerId()), offerId: k.offer().offerId().toString() } };
    case 'data':
      return { type: 'data', fields: { account: pk(k.data().accountId()), dataName: k.data().dataName().toString() } };
    case 'claimableBalance':
      return { type: 'claimable-balance', fields: { balanceId: '00000000' + k.claimableBalance().balanceId().v0().toString('hex') } };
    case 'liquidityPool':
      return { type: 'liquidity-pool', fields: { poolId: k.liquidityPool().liquidityPoolId().toString('hex') } };
    case 'contractData': {
      const cd = k.contractData();
      return {
        type: 'contract-data',
        fields: {
          contract: Address.fromScAddress(cd.contract()).toString(),
          durability: cd.durability().name,
          key: cd.key().toXDR('base64'),
          keyType: cd.key().switch().name,
        },
      };
    }
    case 'contractCode':
      return { type: 'contract-code', fields: { wasmHash: k.contractCode().hash().toString('hex') } };
    default:
      throw new Error(`Unsupported ledger key type "${k.switch().name}"`);
  }
}

export function buildRpcRequestExample(keys: string[]): object {
  return { jsonrpc: '2.0', id: 1, method: 'getLedgerEntries', params: { keys } };
}

export function formatDecodedKey(d: DecodedKey): string {
  return [`Type: ${d.type}`, ...Object.entries(d.fields).map(([k, v]) => `  ${k}: ${v}`)].join('\n');
}
