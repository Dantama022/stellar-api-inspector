/**
 * Soroban Contract Interface and Specification Audit — Inspector adapter (ISSUE-069)
 *
 * Thin adapter re-exporting the contract-spec-audit service for use by the CLI.
 */

export { auditContractSpec } from '../services/contract-spec-audit';

export type {
  ContractSpecAuditOptions,
  ContractSpecAuditResult,
  ContractSpecFunction,
  ContractSpecFunctionInput,
  ContractSpecUdt,
  ContractSpecUdtField,
  ContractSpecStatus,
} from '../services/contract-spec-audit';
