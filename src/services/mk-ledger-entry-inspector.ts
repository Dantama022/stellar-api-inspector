import { xdr, StrKey } from '@stellar/stellar-sdk';

export interface LedgerEntryFinding {
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
}

export interface LedgerEntryReport {
  valid: boolean;
  entryType: string | null;
  lastModifiedLedgerSeq: number | null;
  sponsor: string | null;
  fields: Record<string, unknown>;
  findings: LedgerEntryFinding[];
  note: string;
}

const NOTE = 'Structural validation of the supplied XDR only; this is not verification of actual network state.';

function toStr(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && typeof (v as { toString: () => string }).toString === 'function') return (v as { toString: () => string }).toString();
  return String(v);
}

function assetStr(a: xdr.Asset | xdr.TrustLineAsset): string {
  const sw = a.switch().name;
  if (sw === 'assetTypeNative') return 'native';
  if (sw === 'assetTypePoolShare') return 'pool_share';
  const alpha = (a as xdr.Asset).alphaNum4?.() ?? (a as xdr.Asset).alphaNum12?.();
  const code = Buffer.from(alpha.assetCode()).toString('utf8').replace(/\0+$/, '');
  return `${code}:${StrKey.encodeEd25519PublicKey(alpha.issuer().ed25519())}`;
}

function accountIdStr(a: xdr.AccountId): string {
  return StrKey.encodeEd25519PublicKey(a.ed25519());
}

export function inspectLedgerEntryXdr(input: string): LedgerEntryReport {
  const findings: LedgerEntryFinding[] = [];
  const fail = (code: string, message: string): LedgerEntryReport => ({
    valid: false, entryType: null, lastModifiedLedgerSeq: null, sponsor: null, fields: {}, findings: [{ severity: 'error', code, message }], note: NOTE,
  });
  const text = input.trim();
  if (!text) return fail('EMPTY_INPUT', 'No XDR input provided.');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return fail('INVALID_BASE64', 'Input is not valid base64.');
  let entry: xdr.LedgerEntry;
  try {
    entry = xdr.LedgerEntry.fromXDR(text, 'base64');
  } catch (e) {
    return fail('XDR_DECODE_FAILED', `Malformed, truncated or unsupported LedgerEntry XDR: ${e instanceof Error ? e.message : String(e)}`);
  }
  const data = entry.data();
  const entryType = data.switch().name;
  const fields: Record<string, unknown> = {};
  const err = (code: string, message: string) => findings.push({ severity: 'error', code, message });
  try {
    switch (entryType) {
      case 'account': {
        const a = data.account();
        fields.accountId = accountIdStr(a.accountId());
        fields.balance = toStr(a.balance());
        fields.seqNum = toStr(a.seqNum());
        fields.numSubEntries = a.numSubEntries();
        fields.flags = a.flags();
        fields.signers = a.signers().length;
        if (a.balance().toBigInt() < 0n) err('NEGATIVE_BALANCE', 'Account balance is negative.');
        break;
      }
      case 'trustline': {
        const t = data.trustLine();
        fields.accountId = accountIdStr(t.accountId());
        fields.asset = assetStr(t.asset());
        fields.balance = toStr(t.balance());
        fields.limit = toStr(t.limit());
        fields.flags = t.flags();
        if (t.balance().toBigInt() > t.limit().toBigInt()) err('BALANCE_EXCEEDS_LIMIT', 'Trustline balance exceeds limit.');
        break;
      }
      case 'offer': {
        const o = data.offer();
        fields.sellerId = accountIdStr(o.sellerId());
        fields.offerId = toStr(o.offerId());
        fields.selling = assetStr(o.selling());
        fields.buying = assetStr(o.buying());
        fields.amount = toStr(o.amount());
        fields.price = { n: o.price().n(), d: o.price().d() };
        if (o.price().d() === 0) err('ZERO_PRICE_DENOMINATOR', 'Offer price denominator is zero.');
        if (o.amount().toBigInt() <= 0n) err('NON_POSITIVE_AMOUNT', 'Offer amount must be positive.');
        break;
      }
      case 'data': {
        const d = data.data();
        fields.accountId = accountIdStr(d.accountId());
        fields.dataName = d.dataName().toString();
        fields.dataValueHex = Buffer.from(d.dataValue()).toString('hex');
        if (!d.dataName().toString()) err('EMPTY_DATA_NAME', 'Data entry name is empty.');
        break;
      }
      case 'claimableBalance': {
        const c = data.claimableBalance();
        fields.balanceId = Buffer.from(c.balanceId().v0()).toString('hex');
        fields.asset = assetStr(c.asset());
        fields.amount = toStr(c.amount());
        fields.claimants = c.claimants().length;
        if (c.claimants().length === 0) err('NO_CLAIMANTS', 'Claimable balance has no claimants.');
        break;
      }
      case 'liquidityPool': {
        const p = data.liquidityPool();
        fields.liquidityPoolId = Buffer.from(p.liquidityPoolId()).toString('hex');
        const cp = p.body().constantProduct();
        fields.assetA = assetStr(cp.params().assetA());
        fields.assetB = assetStr(cp.params().assetB());
        fields.fee = cp.params().fee();
        fields.reserveA = toStr(cp.reserveA());
        fields.reserveB = toStr(cp.reserveB());
        fields.totalPoolShares = toStr(cp.totalPoolShares());
        fields.poolSharesTrustLineCount = toStr(cp.poolSharesTrustLineCount());
        break;
      }
      case 'contractData': {
        const c = data.contractData();
        fields.contract = toStr(c.contract().switch().name);
        fields.durability = c.durability().name;
        fields.key = c.key().switch().name;
        fields.val = c.val().switch().name;
        break;
      }
      case 'contractCode': {
        const c = data.contractCode();
        fields.hash = Buffer.from(c.hash()).toString('hex');
        fields.codeBytes = c.code().length;
        if (c.code().length === 0) err('EMPTY_CODE', 'Contract code is empty.');
        break;
      }
      case 'ttl': {
        const t = data.ttl();
        fields.keyHash = Buffer.from(t.keyHash()).toString('hex');
        fields.liveUntilLedgerSeq = t.liveUntilLedgerSeq();
        break;
      }
      default:
        fields.rawXdr = text;
        findings.push({ severity: 'warning', code: 'UNSUPPORTED_ENTRY_TYPE', message: `Entry type "${entryType}" is not decoded in detail; raw XDR preserved.` });
    }
  } catch (e) {
    err('FIELD_EXTRACTION_FAILED', `Could not extract fields for ${entryType}: ${e instanceof Error ? e.message : String(e)}`);
  }

  let sponsor: string | null = null;
  try {
    const sp = entry.ext().switch() === 1 ? entry.ext().v1().sponsoringId() : null;
    if (sp) sponsor = accountIdStr(sp);
  } catch {
    findings.push({ severity: 'info', code: 'SPONSOR_UNAVAILABLE', message: 'Sponsorship information could not be read.' });
  }
  return {
    valid: !findings.some((f) => f.severity === 'error'),
    entryType,
    lastModifiedLedgerSeq: entry.lastModifiedLedgerSeq(),
    sponsor,
    fields,
    findings,
    note: NOTE,
  };
}

export function formatLedgerEntryReport(r: LedgerEntryReport): string {
  const lines = [`Ledger entry: ${r.entryType ?? 'unknown'} (${r.valid ? 'structurally valid' : 'invalid'})`];
  if (r.entryType) {
    lines.push(`Last modified ledger: ${r.lastModifiedLedgerSeq}`, `Sponsor: ${r.sponsor ?? '(none)'}`);
    for (const [k, v] of Object.entries(r.fields)) lines.push(`  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  }
  for (const f of r.findings) lines.push(`[${f.severity}] ${f.code}: ${f.message}`);
  lines.push(r.note);
  return lines.join('\n');
}
