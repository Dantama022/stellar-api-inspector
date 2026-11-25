import { Address, Asset, StrKey, xdr } from '@stellar/stellar-sdk';

export interface RdjLedgerKeyReport {
  entryType: string;
  category: 'classic' | 'soroban' | 'unknown';
  identifiers: Record<string, unknown>;
  note: string;
}

function assetId(a: xdr.Asset): string {
  const asset = Asset.fromOperation(a);
  return asset.isNative() ? 'native' : `${asset.getCode()}:${asset.getIssuer()}`;
}
const acct = (a: xdr.AccountId) => StrKey.encodeEd25519PublicKey(a.ed25519());

export function inspectLedgerKey(inputXdr: string): RdjLedgerKeyReport {
  const raw = (inputXdr || '').trim();
  if (!raw) throw new Error('Input XDR is empty.');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new Error('Input is not valid base64.');
  let key: xdr.LedgerKey;
  try {
    key = xdr.LedgerKey.fromXDR(raw, 'base64');
  } catch (e) {
    throw new Error(`Unable to decode LedgerKey XDR (malformed or truncated): ${(e as Error).message}`);
  }
  const type = key.switch().name;
  let category: RdjLedgerKeyReport['category'] = 'classic';
  let ids: Record<string, unknown>;
  switch (type) {
    case 'account':
      ids = { accountId: acct(key.account().accountId()) };
      break;
    case 'trustline': {
      const t = key.trustLine();
      const line = t.asset();
      ids = {
        accountId: acct(t.accountId()),
        asset: line.switch().name === 'assetTypePoolShare'
          ? { poolId: line.liquidityPoolId().toString('hex') }
          : assetId(xdr.Asset.fromXDR(line.toXDR())),
      };
      break;
    }
    case 'offer':
      ids = { sellerId: acct(key.offer().sellerId()), offerId: key.offer().offerId().toString() };
      break;
    case 'data':
      ids = { accountId: acct(key.data().accountId()), dataName: key.data().dataName().toString() };
      break;
    case 'claimableBalance':
      ids = { balanceIdType: key.claimableBalance().balanceId().switch().name, balanceId: key.claimableBalance().balanceId().toXDR('hex') };
      break;
    case 'liquidityPool':
      ids = { liquidityPoolId: key.liquidityPool().liquidityPoolId().toString('hex') };
      break;
    case 'contractData': {
      category = 'soroban';
      const c = key.contractData();
      ids = {
        contract: Address.fromScAddress(c.contract()).toString(),
        durability: c.durability().name,
        key: c.key().toXDR('base64'),
      };
      break;
    }
    case 'contractCode':
      category = 'soroban';
      ids = { hash: key.contractCode().hash().toString('hex') };
      break;
    default:
      category = 'unknown';
      ids = { rawXdr: raw };
  }
  return {
    entryType: type,
    category,
    identifiers: ids,
    note: 'Identifies a ledger entry only; the entry contents are not retrieved from a key alone.',
  };
}

export function formatRdjLedgerKeyReport(r: RdjLedgerKeyReport): string {
  const lines = [`Entry type: ${r.entryType} (${r.category})`];
  for (const [k, v] of Object.entries(r.identifiers)) lines.push(`  ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  lines.push(r.note);
  return lines.join('\n');
}
