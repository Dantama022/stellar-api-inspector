/**
 * SEP-24 Transaction Inspector (ISSUE-066)
 * Thin re-export wrapper around the sep24-transaction-inspector service.
 */
export { inspectSep24Transaction } from '../services/sep24-transaction-inspector';

export type {
  Sep24InspectionOptions,
  Sep24InspectionResult,
  Sep24TransactionDetails,
  Sep24TransactionStatus,
  Sep24Finding,
  Sep24FindingSeverity,
} from '../services/sep24-transaction-inspector';
