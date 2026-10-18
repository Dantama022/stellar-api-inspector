/**
 * SEP-38 Quote Inspector (ISSUE-067)
 * Thin re-export wrapper around the sep38-quote-validator service.
 */
export { validateSep38Quote } from '../services/sep38-quote-validator';

export type {
  Sep38QuoteInput,
  Sep38ValidationResult,
  Sep38QuoteDetails,
  Sep38QuoteType,
  Sep38Finding,
  Sep38FindingSeverity,
  Sep38PriceConsistency,
} from '../services/sep38-quote-validator';
