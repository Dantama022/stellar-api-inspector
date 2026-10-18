/**
 * SEP-10 Challenge Inspector (ISSUE-065)
 * Thin re-export wrapper around the sep10-challenge-validator service.
 */
export { validateSep10Challenge } from '../services/sep10-challenge-validator';

export type {
  Sep10ValidationOptions,
  Sep10ValidationResult,
  Sep10ValidationStatus,
  Sep10Finding,
  Sep10FindingSeverity,
  Sep10ChallengeDetails,
} from '../services/sep10-challenge-validator';
