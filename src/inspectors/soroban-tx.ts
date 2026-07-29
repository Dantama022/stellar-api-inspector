/**
 * soroban-tx inspector
 *
 * Thin re-export layer that wires the transaction-inspector service into the
 * CLI command pattern used by the rest of the inspectors directory.
 * Heavy lifting lives in src/services/transaction-inspector.ts.
 */

export {
  inspectSorobanTransaction,
  validateTransactionHash,
} from '../services/transaction-inspector';

export type {
  SorobanTxResult,
  SorobanTxStatus,
  SorobanEventEntry,
  SorobanResourceUsage,
  SorobanFeeInfo,
  InspectSorobanTxOptions,
} from '../services/transaction-inspector';
