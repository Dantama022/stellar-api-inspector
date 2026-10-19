/**
 * SEP-30 Account Recovery Server Inspection — Inspector adapter (ISSUE-070)
 *
 * Thin adapter that re-exports the service and its types for use by the CLI
 * and any other consumers. Reads a SEP-30 recovery response and audits the
 * signer/threshold relationship against the on-chain account.
 */

export {
  inspectSep30Recovery,
} from '../services/sep30-recovery-inspection';

export type {
  Sep30RecoveryInspectionOptions,
  Sep30RecoveryInspectionResult,
  Sep30RecoverySignerEntry,
  Sep30RecoveryThresholdResult,
  Sep30AuditFinding,
  Sep30AuditStatus,
  Sep30SignerStatus,
} from '../services/sep30-recovery-inspection';
