/**
 * Soroban Transaction Footprint and Read-Write Access Audit (ISSUE-160)
 *
 * Read-only diagnostic that extracts the DECLARED read-only and read-write
 * footprint from a Soroban transaction envelope's SorobanTransactionData and
 * summarizes it by ledger-key type and access category.
 *
 * A declared footprint describes which ledger entries the transaction is
 * permitted to access. It is not proof of actual runtime reads/writes and not
 * proof of successful execution. This module does not simulate or estimate
 * resources (see soroban simulation / resource-budget commands for that).
 *
 * Checks applied:
 *   - Duplicate keys within one access list (warning: may be rejected by the
 *     network as a malformed footprint).
 *   - Same key declared both read-only and read-write (warning).
 *   - Ledger-key types outside the set Soroban footprints use (account,
 *     trustline, contractData, contractCode) (warning).
 *   - Undecodable envelopes or missing Soroban data (error / inconclusive).
 */

import { Address, StrKey, xdr } from '@stellar/stellar-sdk';

export type FootprintSeverity = 'error' | 'warning' | 'info' | 'inconclusive';

export interface FootprintFinding {
  code: string;
  severity: FootprintSeverity;
  entry?: string;
  message: string;
}

export interface FootprintEntry {
  access: 'readOnly' | 'readWrite';
  index: number;
  keyType: string;
  description: string;
  keyXdr: string;
}

export interface FootprintAuditResult {
  sorobanDataPresent: boolean;
  entries: FootprintEntry[];
  counts: {
    readOnly: number;
    readWrite: number;
    byKeyType: Record<string, { readOnly: number; readWrite: number }>;
  };
  findings: FootprintFinding[];
  summary: { errors: number; warnings: number; info: number; inconclusive: number };
  note: string;
}

const FOOTPRINT_KEY_TYPES = new Set(['account', 'trustline', 'contractData', 'contractCode']);

function describeKey(key: xdr.LedgerKey): string {
  switch (key.switch().name) {
    case 'account':
      return StrKey.encodeEd25519PublicKey(key.account().accountId().ed25519());
    case 'trustline':
      return `${StrKey.encodeEd25519PublicKey(key.trustLine().accountId().ed25519())} / ${key.trustLine().asset().switch().name}`;
    case 'contractData': {
      const cd = key.contractData();
      return `${Address.fromScAddress(cd.contract()).toString()} / ${cd.key().switch().name} / ${cd.durability().name}`;
    }
    case 'contractCode':
      return Buffer.from(key.contractCode().hash()).toString('hex');
    default:
      return key.switch().name;
  }
}

export function auditSorobanFootprint(envelopeXdr: string): FootprintAuditResult {
  const findings: FootprintFinding[] = [];
  const entries: FootprintEntry[] = [];
  let sorobanDataPresent = false;

  try {
    const envelope = xdr.TransactionEnvelope.fromXDR(envelopeXdr, 'base64');
    const kind = envelope.switch().name;
    if (kind === 'envelopeTypeTxV0') {
      findings.push({
        code: 'NO_SOROBAN_DATA',
        severity: 'inconclusive',
        message: 'V0 envelopes cannot carry Soroban transaction data.',
      });
    } else {
      const tx =
        kind === 'envelopeTypeTxFeeBump'
          ? envelope.feeBump().tx().innerTx().v1().tx()
          : envelope.v1().tx();
      if (tx.ext().switch() !== 1) {
        findings.push({
          code: 'NO_SOROBAN_DATA',
          severity: 'inconclusive',
          message:
            'Transaction has no SorobanTransactionData; there is no declared footprint to inspect.',
        });
      } else {
        sorobanDataPresent = true;
        const footprint = tx.ext().sorobanData().resources().footprint();
        const lists: Array<['readOnly' | 'readWrite', xdr.LedgerKey[]]> = [
          ['readOnly', footprint.readOnly()],
          ['readWrite', footprint.readWrite()],
        ];
        for (const [access, keys] of lists) {
          keys.forEach((key, index) => {
            const keyXdr = key.toXDR('base64');
            const keyType = key.switch().name;
            let description: string;
            try {
              description = describeKey(key);
            } catch (err) {
              description = 'undecodable';
              findings.push({
                code: 'UNDECODABLE_FOOTPRINT_KEY',
                severity: 'error',
                entry: `${access}[${index}]`,
                message: `Key could not be decoded: ${err instanceof Error ? err.message : String(err)}`,
              });
            }
            entries.push({ access, index, keyType, description, keyXdr });
            if (!FOOTPRINT_KEY_TYPES.has(keyType)) {
              findings.push({
                code: 'UNSUPPORTED_FOOTPRINT_KEY_TYPE',
                severity: 'warning',
                entry: `${access}[${index}]`,
                message: `Ledger-key type "${keyType}" is not one Soroban footprints are expected to contain.`,
              });
            }
          });
        }
      }
    }
  } catch (err) {
    findings.push({
      code: 'MALFORMED_ENVELOPE',
      severity: 'error',
      message: `Envelope XDR could not be decoded: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  const seen = new Map<string, FootprintEntry>();
  for (const entry of entries) {
    const prior = seen.get(entry.keyXdr);
    if (!prior) {
      seen.set(entry.keyXdr, entry);
      continue;
    }
    const conflict = prior.access !== entry.access;
    findings.push({
      code: conflict ? 'READ_WRITE_CONFLICT' : 'DUPLICATE_FOOTPRINT_ENTRY',
      severity: 'warning',
      entry: `${entry.access}[${entry.index}]`,
      message: conflict
        ? `Key ${entry.description} is declared in both readOnly[${prior.index}] and readWrite; the network may reject this footprint.`
        : `Key ${entry.description} is declared more than once in ${entry.access}; the network may reject this footprint.`,
    });
  }

  const byKeyType: FootprintAuditResult['counts']['byKeyType'] = {};
  for (const entry of entries) {
    const bucket = (byKeyType[entry.keyType] ??= { readOnly: 0, readWrite: 0 });
    bucket[entry.access] += 1;
  }
  const count = (s: FootprintSeverity): number => findings.filter((f) => f.severity === s).length;
  return {
    sorobanDataPresent,
    entries,
    counts: {
      readOnly: entries.filter((e) => e.access === 'readOnly').length,
      readWrite: entries.filter((e) => e.access === 'readWrite').length,
      byKeyType,
    },
    findings,
    summary: {
      errors: count('error'),
      warnings: count('warning'),
      info: count('info'),
      inconclusive: count('inconclusive'),
    },
    note: 'Declared footprint only; not proof of actual runtime reads/writes or successful execution.',
  };
}
