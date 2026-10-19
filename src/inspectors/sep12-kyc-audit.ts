/**
 * SEP-12 Customer KYC Status Audit — Inspector adapter (ISSUE-068)
 *
 * Thin adapter re-exporting the sep12-kyc-audit service for use by the CLI.
 */

export { auditSep12Kyc } from '../services/sep12-kyc-audit';

export type {
  Sep12KycAuditOptions,
  Sep12KycAuditResult,
  Sep12FieldSummary,
  Sep12KycStatus,
  Sep12FieldVerificationStatus,
  Sep12AuditFinding,
} from '../services/sep12-kyc-audit';
