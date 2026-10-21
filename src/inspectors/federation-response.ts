import { promises as fs } from 'fs';
import path from 'path';

import {
  validateFederationResponse,
  type FederationResponseValidationOptions,
  type FederationResponseValidationReport,
  type FederationLookupQuery,
  type FederationLookupResult,
  type FederationMemoType,
  type FederationResponseFinding,
  type FederationResponseFindingCode,
  type FederationResponseFindingSeverity,
} from '../services/federation-response-validator';
import { isValidUrl, normalizeUrl } from '../utils/urls';

export type {
  FederationResponseValidationOptions,
  FederationResponseValidationReport,
  FederationLookupQuery,
  FederationLookupResult,
  FederationMemoType,
  FederationResponseFinding,
  FederationResponseFindingCode,
  FederationResponseFindingSeverity,
};

/**
 * Options for the federation response inspector entry point.
 *
 * Offline mode: provide `responsePath` (and optionally `query`) to validate a
 * saved federation JSON response without contacting any remote service.
 *
 * Online mode: additionally provide `federationEndpoint` to perform a live
 * federation lookup using the configured endpoint. The lookup result is then
 * validated and compared against the original query.
 */
export interface FederationResponseInspectorOptions {
  /** Path to a saved federation JSON response (offline mode). */
  responsePath?: string;
  /** Raw federation JSON response content (alternative to `responsePath`). */
  responseContent?: string;
  /** Original federation lookup query, used for identity-resolution diagnostics. */
  query?: FederationLookupQuery;
  /** Configured federation endpoint used for an optional live lookup (online mode). */
  federationEndpoint?: string;
  /** Whether to perform a live lookup against `federationEndpoint`. */
  performLookup?: boolean;
  /** Timeout in milliseconds for the live lookup. */
  timeoutMs?: number;
  /** Redact sensitive query details from diagnostic output. */
  redactSensitive?: boolean;
}

export class FederationResponseInspectorError extends Error {
  public readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'FederationResponseInspectorError';
    this.code = code;
  }
}

/**
 * Read and parse a saved federation JSON response from disk.
 */
async function readResponseFile(responsePath: string): Promise<unknown> {
  const resolved = path.resolve(responsePath);
  let raw: string;
  try {
    raw = await fs.readFile(resolved, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new FederationResponseInspectorError(
      `Unable to read federation response file at "${resolved}": ${message}`,
      'FEDERATION_RESPONSE_FILE_READ_ERROR',
    );
  }
  return parseResponseContent(raw, resolved);
}

/**
 * Parse raw federation JSON content, producing a clear error for malformed JSON.
 */
function parseResponseContent(raw: string, source: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new FederationResponseInspectorError(
      `Federation response from "${source}" is empty.`,
      'FEDERATION_RESPONSE_EMPTY',
    );
  }
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new FederationResponseInspectorError(
      `Malformed JSON in federation response from "${source}": ${message}`,
      'FEDERATION_RESPONSE_MALFORMED_JSON',
    );
  }
}

/**
 * Validate a configured federation endpoint URL.
 */
function validateFederationEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim();
  if (trimmed.length === 0) {
    throw new FederationResponseInspectorError(
      'Federation endpoint URL must not be empty.',
      'FEDERATION_ENDPOINT_EMPTY',
    );
  }
  if (!isValidUrl(trimmed)) {
    throw new FederationResponseInspectorError(
      `Invalid federation endpoint URL: "${trimmed}".`,
      'FEDERATION_ENDPOINT_INVALID',
    );
  }
  return normalizeUrl(trimmed);
}

/**
 * Entry point for the federation response inspector.
 *
 * Reads a saved federation JSON response (offline mode) and/or performs an
 * optional live lookup against a configured federation endpoint (online mode),
 * then delegates to the federation response validator service.
 *
 * This inspector never initiates payments and never automatically trusts a
 * resolved identity; a syntactically valid response is not proof of ownership.
 */
export async function inspectFederationResponse(
  options: FederationResponseInspectorOptions,
): Promise<FederationResponseValidationReport> {
  const {
    responsePath,
    responseContent,
    query,
    federationEndpoint,
    performLookup = false,
    timeoutMs,
    redactSensitive,
  } = options ?? {};

  if (!responsePath && responseContent === undefined && !performLookup) {
    throw new FederationResponseInspectorError(
      'No federation response provided. Supply a responsePath, responseContent, or enable performLookup with a federationEndpoint.',
      'FEDERATION_RESPONSE_MISSING_INPUT',
    );
  }

  let response: unknown;
  if (responseContent !== undefined) {
    response = parseResponseContent(responseContent, 'inline content');
  } else if (responsePath) {
    response = await readResponseFile(responsePath);
  }

  let endpoint: string | undefined;
  if (performLookup) {
    if (!federationEndpoint) {
      throw new FederationResponseInspectorError(
        'A federation endpoint is required to perform a live lookup.',
        'FEDERATION_ENDPOINT_REQUIRED',
      );
    }
    endpoint = validateFederationEndpoint(federationEndpoint);
  } else if (federationEndpoint !== undefined) {
    // Validate the endpoint even when not performing a lookup so misconfiguration
    // surfaces early, but do not contact the remote service.
    endpoint = validateFederationEndpoint(federationEndpoint);
  }

  const validationOptions: FederationResponseValidationOptions = {
    response: response as string | Record<string, unknown> | undefined,
    query,
    endpoint,
  };

  return validateFederationResponse(validationOptions);
}

export default inspectFederationResponse;