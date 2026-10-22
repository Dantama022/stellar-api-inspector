/**
 * Transaction operation asset compatibility audit (ISSUE-163).
 *
 * Decodes an envelope with @stellar/stellar-sdk, extracts asset references
 * from asset-bearing operations and checks them against protocol rules.
 * Optionally checks destination trustlines via Horizon; missing trustlines
 * are warnings, never confirmed failures, since earlier operations or other
 * transactions may create them.
 *
 * Does not duplicate operation authorization, asset-flow reconciliation or
 * protocol compatibility audits: only asset references are inspected.
 */

import {
  Asset,
  FeeBumpTransaction,
  Networks,
  StrKey,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

export type AssetAuditSeverity = 'error' | 'warning' | 'info' | 'inconclusive';
export type AssetAuditStatus = 'pass' | 'fail' | 'warn' | 'inconclusive';

export interface AssetAuditFinding {
  operationIndex: number | null;
  operationType: string | null;
  asset: string | null;
  severity: AssetAuditSeverity;
  code: string;
  message: string;
}

export interface AssetAuditOperation {
  index: number;
  type: string;
  checked: boolean;
  assets: string[];
}

export interface OperationAssetAuditResult {
  transactionHash: string | null;
  sourceAccount: string | null;
  status: AssetAuditStatus;
  operations: AssetAuditOperation[];
  findings: AssetAuditFinding[];
  networkChecks: boolean;
  auditedAt: string;
}

export interface OperationAssetAuditOptions {
  envelopeXdr: string;
  networkPassphrase?: string;
  /** When set, destination trustlines are checked against Horizon. */
  horizonUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

const ASSET_CODE_RE = /^[a-zA-Z0-9]{1,12}$/;

/** Validates an asset definition against protocol rules. Returns problems found. */
export function validateAssetReference(
  code: string | undefined,
  issuer: string | undefined,
): string[] {
  const problems: string[] = [];
  if (code === undefined || code === '') problems.push('asset code is missing');
  else if (!ASSET_CODE_RE.test(code))
    problems.push(`asset code "${code}" must be 1-12 alphanumeric characters`);
  if (code !== undefined && code.toUpperCase() !== 'XLM' && issuer === undefined)
    problems.push('issuer is missing');
  else if (issuer !== undefined && !StrKey.isValidEd25519PublicKey(issuer))
    problems.push(`issuer "${issuer}" is not a valid account ID`);
  return problems;
}

type AnyAsset =
  | Asset
  | { getAssetType?: () => string; poolId?: string; assetA?: Asset; assetB?: Asset };

function label(a: AnyAsset): string {
  if (a instanceof Asset) return a.isNative() ? 'native' : `${a.getCode()}:${a.getIssuer()}`;
  if ('assetA' in a && a.assetA && a.assetB) return `pool(${label(a.assetA)},${label(a.assetB)})`;
  if ('poolId' in a && a.poolId) return `pool:${a.poolId}`;
  return 'unknown';
}

function baseAccount(addr: string): string {
  if (StrKey.isValidMed25519PublicKey(addr)) {
    return StrKey.encodeEd25519PublicKey(StrKey.decodeMed25519PublicKey(addr).subarray(0, 32));
  }
  return addr;
}

export async function auditOperationAssetCompatibility(
  opts: OperationAssetAuditOptions,
): Promise<OperationAssetAuditResult> {
  const findings: AssetAuditFinding[] = [];
  const operations: AssetAuditOperation[] = [];
  const auditedAt = (opts.now ?? (() => new Date()))().toISOString();
  const passphrase = opts.networkPassphrase ?? Networks.PUBLIC;

  let tx: Transaction;
  try {
    const decoded = TransactionBuilder.fromXDR(opts.envelopeXdr.trim(), passphrase);
    tx = decoded instanceof FeeBumpTransaction ? decoded.innerTransaction : decoded;
  } catch (err) {
    return {
      transactionHash: null,
      sourceAccount: null,
      status: 'fail',
      operations,
      findings: [
        {
          operationIndex: null,
          operationType: null,
          asset: null,
          severity: 'error',
          code: 'MALFORMED_ENVELOPE',
          message: `Envelope could not be decoded: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      networkChecks: false,
      auditedAt,
    };
  }

  const txSource = baseAccount(tx.source);
  const trustRequests: Array<{ index: number; type: string; account: string; asset: Asset }> = [];
  const changeTrustInTx = new Set<string>();

  tx.operations.forEach((op, index) => {
    const o = op as unknown as Record<string, unknown> & { type: string; source?: string };
    const opSource = baseAccount(o.source ?? txSource);
    const assets: AnyAsset[] = [];
    const add = (
      severity: AssetAuditSeverity,
      code: string,
      message: string,
      asset: AnyAsset | null = null,
    ): void => {
      findings.push({
        operationIndex: index,
        operationType: o.type,
        asset: asset ? label(asset) : null,
        severity,
        code,
        message,
      });
    };
    const requireIssued = (a: Asset): void => {
      if (a.isNative())
        add('error', 'NATIVE_NOT_ALLOWED', `${o.type} cannot reference the native asset.`, a);
    };
    let checked = true;

    switch (o.type) {
      case 'payment':
      case 'createClaimableBalance': {
        const a = o.asset as Asset;
        assets.push(a);
        if (o.type === 'payment' && !a.isNative()) {
          trustRequests.push({
            index,
            type: o.type,
            account: baseAccount(o.destination as string),
            asset: a,
          });
        }
        break;
      }
      case 'pathPaymentStrictSend':
      case 'pathPaymentStrictReceive': {
        const send = o.sendAsset as Asset;
        const dest = o.destAsset as Asset;
        const path = (o.path as Asset[]) ?? [];
        assets.push(send, ...path, dest);
        if (path.length > 5)
          add(
            'error',
            'PATH_TOO_LONG',
            `Path contains ${path.length} assets; the protocol allows at most 5.`,
          );
        if (!dest.isNative())
          trustRequests.push({
            index,
            type: o.type,
            account: baseAccount(o.destination as string),
            asset: dest,
          });
        break;
      }
      case 'manageSellOffer':
      case 'manageBuyOffer':
      case 'createPassiveSellOffer': {
        const selling = o.selling as Asset;
        const buying = o.buying as Asset;
        assets.push(selling, buying);
        if (selling.equals(buying))
          add('error', 'SAME_ASSET_OFFER', 'Offer sells and buys the same asset.', selling);
        break;
      }
      case 'changeTrust': {
        const line = o.line as AnyAsset;
        assets.push(line);
        if (line instanceof Asset) {
          requireIssued(line);
          if (!line.isNative() && line.getIssuer() === opSource) {
            add(
              'error',
              'SELF_TRUSTLINE',
              'An issuer cannot create a trustline to its own asset.',
              line,
            );
          }
          if (!line.isNative()) changeTrustInTx.add(`${opSource}|${label(line)}`);
        }
        break;
      }
      case 'setTrustLineFlags':
      case 'clawback': {
        const a = o.asset as Asset;
        assets.push(a);
        requireIssued(a);
        if (!a.isNative() && a.getIssuer() !== opSource) {
          add(
            'error',
            'NOT_ISSUER',
            `${o.type} must be submitted by the asset issuer (${a.getIssuer()}).`,
            a,
          );
        }
        break;
      }
      case 'allowTrust': {
        const problems = validateAssetReference(o.assetCode as string, opSource);
        problems.forEach((p) => add('error', 'INVALID_ASSET', `allowTrust ${p}.`));
        break;
      }
      case 'liquidityPoolDeposit':
      case 'liquidityPoolWithdraw': {
        const poolId = o.liquidityPoolId as string;
        if (!/^[0-9a-f]{64}$/i.test(poolId ?? ''))
          add(
            'error',
            'INVALID_POOL_ID',
            `Liquidity pool ID "${poolId}" is not a 32-byte hex value.`,
          );
        add(
          'inconclusive',
          'POOL_ASSETS_UNRESOLVED',
          'Pool constituent assets are not encoded in the operation; they were not checked.',
        );
        assets.push({ poolId });
        break;
      }
      default:
        checked = false;
        add(
          'info',
          'UNCHECKED_OPERATION',
          `Operation type ${o.type} is not covered by the asset compatibility audit.`,
        );
    }

    for (const a of assets) {
      if (a instanceof Asset && !a.isNative()) {
        validateAssetReference(a.getCode(), a.getIssuer()).forEach((p) =>
          add('error', 'INVALID_ASSET', `Asset ${p}.`, a),
        );
      }
    }
    operations.push({ index, type: o.type, checked, assets: assets.map(label) });
  });

  // --- network trustline checks --------------------------------------------
  const networkChecks = Boolean(opts.horizonUrl);
  if (opts.horizonUrl) {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const base = opts.horizonUrl.replace(/\/$/, '');
    const cache = new Map<
      string,
      Promise<{ balances: Array<Record<string, string>> } | 'missing' | 'error'>
    >();
    const load = (
      account: string,
    ): Promise<{ balances: Array<Record<string, string>> } | 'missing' | 'error'> => {
      if (!cache.has(account)) {
        cache.set(
          account,
          (async () => {
            try {
              const res = await fetchImpl(`${base}/accounts/${account}`);
              if (res.status === 404) return 'missing';
              if (!res.ok) return 'error';
              const body = (await res.json()) as { balances?: Array<Record<string, string>> };
              return Array.isArray(body.balances) ? { balances: body.balances } : 'error';
            } catch {
              return 'error';
            }
          })(),
        );
      }
      return cache.get(account)!;
    };

    for (const req of trustRequests) {
      const assetLabel = label(req.asset);
      const push = (severity: AssetAuditSeverity, code: string, message: string): void => {
        findings.push({
          operationIndex: req.index,
          operationType: req.type,
          asset: assetLabel,
          severity,
          code,
          message,
        });
      };
      if (req.asset.getIssuer() === req.account) continue;
      if (changeTrustInTx.has(`${req.account}|${assetLabel}`)) {
        push(
          'info',
          'TRUSTLINE_CREATED_IN_TX',
          `A changeTrust in this transaction creates the trustline for ${req.account}.`,
        );
        continue;
      }
      const data = await load(req.account);
      if (data === 'missing') {
        push(
          'warning',
          'DESTINATION_NOT_FOUND',
          `Destination ${req.account} does not currently exist; it cannot hold a trustline unless created first.`,
        );
      } else if (data === 'error') {
        push(
          'inconclusive',
          'ACCOUNT_DATA_UNAVAILABLE',
          `Account data for ${req.account} could not be retrieved; trustline not verified.`,
        );
      } else if (
        !data.balances.some(
          (b) => b.asset_code === req.asset.getCode() && b.asset_issuer === req.asset.getIssuer(),
        )
      ) {
        push(
          'warning',
          'MISSING_TRUSTLINE',
          `${req.account} currently has no trustline for ${assetLabel}; the operation would fail unless one is created first.`,
        );
      }
    }
  }

  const has = (s: AssetAuditSeverity): boolean => findings.some((f) => f.severity === s);
  const status: AssetAuditStatus = has('error')
    ? 'fail'
    : has('warning')
      ? 'warn'
      : has('inconclusive')
        ? 'inconclusive'
        : 'pass';

  return {
    transactionHash: tx.hash().toString('hex'),
    sourceAccount: tx.source,
    status,
    operations,
    findings,
    networkChecks,
    auditedAt,
  };
}
