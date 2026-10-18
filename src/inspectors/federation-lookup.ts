/**
 * Federation Lookup Inspector (ISSUE-064)
 * Thin re-export wrapper around the federation-lookup service.
 */
export { lookupFederationAddress, parseFederationAddress } from '../services/federation-lookup';

export type {
  FederationLookupOptions,
  FederationLookupResult,
  FederationLookupStatus,
  FederationFinding,
  FederationFindingSeverity,
  FederationTomlInfo,
  FederationResponse,
} from '../services/federation-lookup';
