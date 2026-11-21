/**
 * Soroban RPC JSON-RPC 2.0 Protocol Compliance and Response Validation Audit
 *
 * Offline diagnostic service that inspects locally supplied Soroban RPC
 * request-response fixtures and validates them against JSON-RPC 2.0 protocol
 * requirements. It also applies method-aware response schemas when available.
 *
 * No network access is required.
 */

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export type JsonRpcId = string | number | null;

export type FindingSeverity =
  | 'protocol-violation'
  | 'method-validation-failure'
  | 'warning'
  | 'inconclusive';

export interface AuditFinding {
  /** Stable machine-readable code for the finding. */
  code: string;
  /** Classification of the finding. */
  severity: FindingSeverity;
  /** Human-readable explanation of what failed. */
  message: string;
  /** Remediation guidance. */
  remediation: string;
  /** Path within the fixture where the issue was detected (e.g. "response.error.code"). */
  path?: string;
  /** Identifier of the affected message ("request" | "response"). */
  message?: 'request' | 'response';
  /** Method associated with the pair, if known. */
  method?: string;
}

export interface PairAuditResult {
  /** Index of the pair within the supplied fixture list. */
  index: number;
  /** Optional label supplied by the caller. */
  label?: string;
  /** RPC method, if determinable. */
  method?: string;
  /** Request id, if determinable. */
  requestId?: JsonRpcId;
  /** Response id, if determinable. */
  responseId?: JsonRpcId;
  /** Whether the pair passed all applicable checks (no violations or failures). */
  valid: boolean;
  /** Findings for this pair. */
  findings: AuditFinding[];
}

export interface AuditSummary {
  totalPairs: number;
  validPairs: number;
  invalidPairs: number;
  protocolViolations: number;
  methodValidationFailures: number;
  warnings: number;
  inconclusive: number;
}

export interface AuditReport {
  /** Report schema version. */
  version: string;
  /** Timestamp of report generation (ISO 8601). */
  generatedAt: string;
  summary: AuditSummary;
  pairs: PairAuditResult[];
}

export interface RequestResponsePair {
  /** Optional label for the pair. */
  label?: string;
  /** The raw request message (object or JSON string). */
  request: unknown;
  /** The raw response message (object or JSON string). May be omitted for incomplete fixtures. */
  response?: unknown;
}

export interface AuditOptions {
  /**
   * Optional map of method name -> response schema validator.
   * When a method has no schema, method-specific checks are reported as
   * inconclusive rather than as protocol violations.
   */
  methodSchemas?: Record<string, MethodResponseSchema>;
}

/**
 * A method-aware response schema. The validator receives the parsed
 * response `result` and returns a list of method-specific findings.
 */
export interface MethodResponseSchema {
  /** Human-readable description of the schema. */
  description?: string;
  /** Validate the response result. Return findings for any failures. */
  validate: (result: unknown, context: MethodValidationContext) => MethodValidationIssue[];
}

export interface MethodValidationContext {
  method: string;
  requestId?: JsonRpcId;
  responseId?: JsonRpcId;
}

export interface MethodValidationIssue {
  code: string;
  message: string;
  remediation: string;
  path?: string;
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

const REPORT_VERSION = '1.0.0';
const JSONRPC_VERSION = '2.0';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isValidId(id: unknown): id is JsonRpcId {
  return id === null || typeof id === 'string' || typeof id === 'number';
}

function describeId(id: unknown): string {
  if (id === undefined) return 'undefined';
  if (id === null) return 'null';
  try {
    return JSON.stringify(id);
  } catch {
    return String(id);
  }
}

/**
 * Parse a raw message that may already be an object or a JSON string.
 * Returns either the parsed value or a parse error.
 */
function parseMessage(raw: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  if (typeof raw === 'string') {
    try {
      return { ok: true, value: JSON.parse(raw) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  return { ok: true, value: raw };
}

/* -------------------------------------------------------------------------- */
/* Message-level validation                                                   */
/* -------------------------------------------------------------------------- */

interface MessageValidationResult {
  findings: AuditFinding[];
  /** Parsed message, if parsing succeeded. */
  parsed?: Record<string, unknown>;
  /** Whether the message is structurally a valid JSON-RPC message. */
  structurallyValid: boolean;
  /** Whether the message is a request (has method) or a response. */
  kind?: 'request' | 'response';
  id?: JsonRpcId;
  method?: string;
}

function validateJsonRpcVersion(
  msg: Record<string, unknown>,
  message: 'request' | 'response',
  findings: AuditFinding[],
): void {
  if (!hasOwn(msg, 'jsonrpc')) {
    findings.push({
      code: 'MISSING_JSONRPC_VERSION',
      severity: 'protocol-violation',
      message: `The ${message} is missing the required "jsonrpc" field.`,
      remediation: `Add "jsonrpc": "2.0" to the ${message}.`,
      path: 'jsonrpc',
      message: message,
    });
    return;
  }
  if (msg.jsonrpc !== JSONRPC_VERSION) {
    findings.push({
      code: 'INVALID_JSONRPC_VERSION',
      severity: 'protocol-violation',
      message: `The ${message} has an unsupported "jsonrpc" value ${describeId(
        msg.jsonrpc,
      )}; expected "${JSONRPC_VERSION}".`,
      remediation: `Set "jsonrpc" to "${JSONRPC_VERSION}".`,
      path: 'jsonrpc',
      message: message,
    });
  }
}

function validateRequestMessage(
  msg: Record<string, unknown>,
  findings: AuditFinding[],
): MessageValidationResult {
  const result: MessageValidationResult = {
    findings,
    parsed: msg,
    structurallyValid: true,
    kind: 'request',
  };

  validateJsonRpcVersion(msg, 'request', findings);

  // method
  if (!hasOwn(msg, 'method')) {
    findings.push({
      code: 'MISSING_METHOD',
      severity: 'protocol-violation',
      message: 'The request is missing the required "method" field.',
      remediation: 'Add a "method" string identifying the RPC method.',
      path: 'method',
      message: 'request',
    });
    result.structurallyValid = false;
  } else if (typeof msg.method !== 'string' || msg.method.length === 0) {
    findings.push({
      code: 'INVALID_METHOD',
      severity: 'protocol-violation',
      message: 'The request "method" field must be a non-empty string.',
      remediation: 'Provide a non-empty string for "method".',
      path: 'method',
      message: 'request',
    });
    result.structurallyValid = false;
  } else {
    result.method = msg.method;
  }

  // id
  if (!hasOwn(msg, 'id')) {
    findings.push({
      code: 'MISSING_REQUEST_ID',
      severity: 'protocol-violation',
      message: 'The request is missing the required "id" field.',
      remediation: 'Add an "id" (string, number, or null) to correlate with the response.',
      path: 'id',
      message: 'request',
    });
    result.structurallyValid = false;
  } else if (!isValidId(msg.id)) {
    findings.push({
      code: 'INVALID_REQUEST_ID',
      severity: 'protocol-violation',
      message: `The request "id" must be a string, number, or null; received ${typeof msg.id}.`,
      remediation: 'Use a string, number, or null for the request "id".',
      path: 'id',
      message: 'request',
    });
    result.structurallyValid = false;
  } else {
    result.id = msg.id;
  }

  // params (optional, but must be object or array if present)
  if (hasOwn(msg, 'params')) {
    const params = msg.params;
    if (!isPlainObject(params) && !Array.isArray(params)) {
      findings.push({
        code: 'INVALID_PARAMS',
        severity: 'protocol-violation',
        message: 'The request "params" field must be an object or array when present.',
        remediation: 'Provide "params" as a structured object or array, or omit it.',
        path: 'params',
        message: 'request',
      });
    }
  }

  return result;
}

function validateResponseMessage(
  msg: Record<string, unknown>,
  findings: AuditFinding[],
): MessageValidationResult {
  const result: MessageValidationResult = {
    findings,
    parsed: msg,
    structurallyValid: true,
    kind: 'response',
  };

  validateJsonRpcVersion(msg, 'response', findings);

  // id
  if (!hasOwn(msg, 'id')) {
    findings.push({
      code: 'MISSING_RESPONSE_ID',
      severity: 'protocol-violation',
      message: 'The response is missing the required "id" field.',
      remediation: 'Include the "id" from the corresponding request in the response.',
      path: 'id',
      message: 'response',
    });
    result.structurallyValid = false;
  } else if (!isValidId(msg.id)) {
    findings.push({
      code: 'INVALID_RESPONSE_ID',
      severity: 'protocol-violation',
      message: `The response "id" must be a string, number, or null; received ${typeof msg.id}.`,
      remediation: 'Use a string, number, or null for the response "id".',
      path: 'id',
      message: 'response',
    });
    result.structurallyValid = false;
  } else {
    result.id = msg.id;
  }

  const hasResult = hasOwn(msg, 'result');
  const hasError = hasOwn(msg, 'error');

  if (hasResult && hasError) {
    findings.push({
      code: 'CONFLICTING_RESULT_AND_ERROR',
      severity: 'protocol-violation',
      message: 'The response contains both "result" and "error" fields, which is not allowed.',
      remediation: 'A response must contain exactly one of "result" or "error".',
      path: 'result',
      message: 'response',
    });
    result.structurallyValid = false;
  } else if (!hasResult && !hasError) {
    findings.push({
      code: 'MISSING_RESULT_OR_ERROR',
      severity: 'protocol-violation',
      message: 'The response contains neither "result" nor "error".',
      remediation: 'A response must contain exactly one of "result" or "error".',
      path: 'result',
      message: 'response',
    });
    result.structurallyValid = false;
  }

  if (hasError) {
    validateErrorObject(msg.error, findings);
  }

  return result;
}

function validateErrorObject(error: unknown, findings: AuditFinding[]): void {
  if (!isPlainObject(error)) {
    findings.push({
      code: 'INVALID_ERROR_OBJECT',
      severity: 'protocol-violation',
      message: 'The response "error" field must be an object.',
      remediation: 'Provide an error object with "code" and "message" fields.',
      path: 'error',
      message: 'response',
    });
    return;
  }

  if (!hasOwn(error, 'code')) {
    findings.push({
      code: 'MISSING_ERROR_CODE',
      severity: 'protocol-violation',
      message: 'The error object is missing the required "code" field.',
      remediation: 'Add an integer "code" to the error object.',
      path: 'error.code',
      message: 'response',
    });
  } else if (typeof error.code !== 'number' || !Number.isInteger(error.code)) {
    findings.push({
      code: 'INVALID_ERROR_CODE',
      severity: 'protocol-violation',
      message: 'The error "code" must be an integer.',
      remediation: 'Provide an integer value for the error "code".',
      path: 'error.code',
      message: 'response',
    });
  }

  if (!hasOwn(error, 'message')) {
    findings.push({
      code: 'MISSING_ERROR_MESSAGE',
      severity: 'protocol-violation',
      message: 'The error object is missing the required "message" field.',
      remediation: 'Add a string "message" to the error object.',
      path: 'error.message',
      message: 'response',
    });
  } else if (typeof error.message !== 'string') {
    findings.push({
      code: 'INVALID_ERROR_MESSAGE',
      severity: 'protocol-violation',
      message: 'The error "message" must be a string.',
      remediation: 'Provide a string value for the error "message".',
      path: 'error.message',
      message: 'response',
    });
  }

  if (hasOwn(error, 'data')) {
    // "data" is allowed to be any JSON value; no validation required.
  }
}

/* -------------------------------------------------------------------------- */
/* Pair-level validation                                                      */
/* -------------------------------------------------------------------------- */

function auditPair(
  pair: RequestResponsePair,
  index: number,
  options: AuditOptions,
): PairAuditResult {
  const findings: AuditFinding[] = [];
  const result: PairAuditResult = {
    index,
    label: pair.label,
    valid: true,
    findings,
  };

  // Parse request
  const requestParse = parseMessage(pair.request);
  if (!requestParse.ok) {
    findings.push({
      code: 'MALFORMED_REQUEST_JSON',
      severity: 'protocol-violation',
      message: `The request is not valid JSON: ${requestParse.error}`,
      remediation: 'Ensure the request is a well-formed JSON-RPC 2.0 message.',
      message: 'request',
    });
    result.valid = false;
    return finalizePair(result);
  }

  if (!isPlainObject(requestParse.value)) {
    findings.push({
      code: 'INVALID_REQUEST_STRUCTURE',
      severity: 'protocol-violation',
      message: 'The request must be a JSON object.',
      remediation: 'Provide a JSON-RPC 2.0 request object.',
      message: 'request',
    });
    result.valid = false;
    return finalizePair(result);
  }

  const requestResult = validateRequestMessage(requestParse.value, findings);
  if (requestResult.method) result.method = requestResult.method;
  if (requestResult.id !== undefined) result.requestId = requestResult.id;

  // Parse response (may be missing -> incomplete pair)
  if (pair.response === undefined) {
    findings.push({
      code: 'MISSING_RESPONSE',
      severity: 'protocol-violation',
      message: 'The request-response pair is incomplete: no response was supplied.',
      remediation: 'Provide the corresponding response for this request.',
      message: 'response',
    });
    result.valid = false;
    return finalizePair(result);
  }

  const responseParse = parseMessage(pair.response);
  if (!responseParse.ok) {
    findings.push({
      code: 'MALFORMED_RESPONSE_JSON',
      severity: 'protocol-violation',
      message: `The response is not valid JSON: ${responseParse.error}`,
      remediation: 'Ensure the response is a well-formed JSON-RPC 2.0 message.',
      message: 'response',
    });
    result.valid = false;
    return finalizePair(result);
  }

  if (!isPlainObject(responseParse.value)) {
    findings.push({
      code: 'INVALID_RESPONSE_STRUCTURE',
      severity: 'protocol-violation',
      message: 'The response must be a JSON object.',
      remediation: 'Provide a JSON-RPC 2.0 response object.',
      message: 'response',
    });
    result.valid = false;
    return finalizePair(result);
  }

  const responseResult = validateResponseMessage(responseParse.value, findings);
  if (responseResult.id !== undefined) result.responseId = responseResult.id;

  // Correlate IDs
  correlateIds(requestResult, responseResult, findings);

  // Method-aware validation
  applyMethodValidation(requestResult, responseResult, options, findings, result);

  return finalizePair(result);
}

function correlateIds(
  request: MessageValidationResult,
  response: MessageValidationResult,
  findings: AuditFinding[],
): void {
  const reqHasId = request.id !== undefined;
  const resHasId = response.id !== undefined;

  if (!reqHasId || !resHasId) {
    // Missing IDs already reported at message level.
    return;
  }

  if (request.id !== response.id) {
    findings.push({
      code: 'MISMATCHED_IDS',
      severity: 'protocol-violation',
      message: `The response id ${describeId(response.id)} does not match the request id ${describeId(
        request.id,
      )}.`,
      remediation: 'Ensure the response echoes the exact "id" from the corresponding request.',
      path: 'id',
      message: 'response',
    });
  }
}

function applyMethodValidation(
  request: MessageValidationResult,
  response: MessageValidationResult,
  options: AuditOptions,
  findings: AuditFinding[],
  result: PairAuditResult,
): void {
  const method = request.method;
  if (!method) {
    // Cannot determine method; nothing to apply.
    return;
  }

  const schemas = options.methodSchemas;
  const schema = schemas ? schemas[method] : undefined;

  if (!schema) {
    findings.push({
      code: 'NO_METHOD_SCHEMA',
      severity: 'inconclusive',
      message: `No response schema is available for method "${method}"; method-specific validation was skipped.`,
      remediation: 'Register a response schema for this method to enable method-specific validation.',
      message: 'response',
      method,
    });
    return;
  }

  // Only validate result when the response is structurally a success response.
  const parsed = response.parsed;
  if (!parsed) return;

  const hasResult = hasOwn(parsed, 'result');
  const hasError = hasOwn(parsed, 'error');

  if (hasError) {
    // Error responses are validated by protocol checks; method schema applies to results.
    return;
  }

  if (!hasResult) {
    // Missing result already reported as protocol violation.
    return;
  }

  const context: MethodValidationContext = {
    method,
    requestId: request.id,
    responseId: response.id,
  };

  let issues: MethodValidationIssue[];
  try {
    issues = schema.validate(parsed.result, context);
  } catch (err) {
    findings.push({
      code: 'METHOD_SCHEMA_ERROR',
      severity: 'inconclusive',
      message: `The response schema for method "${method}" threw an error during validation: ${
        err instanceof Error ? err.message : String(err)
      }.`,
      remediation: 'Check the method response schema implementation.',
      message: 'response',
      method,
    });
    return;
  }

  for (const issue of issues) {
    findings.push({
      code: issue.code,
      severity: 'method-validation-failure',
      message: issue.message,
      remediation: issue.remediation,
      path: issue.path,
      message: 'response',
      method,
    });
  }
}

function finalizePair(result: PairAuditResult): PairAuditResult {
  result.valid = !result.findings.some(
    (f) => f.severity === 'protocol-violation' || f.severity === 'method-validation-failure',
  );
  return result;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Audit a list of request-response pairs against JSON-RPC 2.0 protocol
 * requirements and any supplied method-aware response schemas.
 */
export function auditJsonRpcPairs(
  pairs: RequestResponsePair[],
  options: AuditOptions = {},
): AuditReport {
  const pairResults = pairs.map((pair, index) => auditPair(pair, index, options));

  const summary: AuditSummary = {
    totalPairs: pairResults.length,
    validPairs: 0,
    invalidPairs: 0,
    protocolViolations: 0,
    methodValidationFailures: 0,
    warnings: 0,
    inconclusive: 0,
  };

  for (const pair of pairResults) {
    if (pair.valid) summary.validPairs += 1;
    else summary.invalidPairs += 1;

    for (const finding of pair.findings) {
      switch (finding.severity) {
        case 'protocol-violation':
          summary.protocolViolations += 1;
          break;
        case 'method-validation-failure':
          summary.methodValidationFailures += 1;
          break;
        case 'warning':
          summary.warnings += 1;
          break;
        case 'inconclusive':
          summary.inconclusive += 1;
          break;
      }
    }
  }

  return {
    version: REPORT_VERSION,
    generatedAt: new Date().toISOString(),
    summary,
    pairs: pairResults,
  };
}

/* -------------------------------------------------------------------------- */
/* Formatters                                                                 */
/* -------------------------------------------------------------------------- */

const SEVERITY_LABELS: Record<FindingSeverity, string> = {
  'protocol-violation': 'PROTOCOL VIOLATION',
  'method-validation-failure': 'METHOD VALIDATION FAILURE',
  warning: 'WARNING',
  inconclusive: 'INCONCLUSIVE',
};

/**
 * Format an audit report as human-readable terminal output.
 */
export function formatAuditReportTerminal(report: AuditReport): string {
  const lines: string[] = [];
  lines.push('Soroban RPC JSON-RPC 2.0 Compliance Audit');
  lines.push('=========================================');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push('');
  lines.push(
    `Pairs: ${report.summary.totalPairs} total, ${report.summary.validPairs} valid, ${report.summary.invalidPairs} invalid`,
  );
  lines.push(
    `Findings: ${report.summary.protocolViolations} protocol violation(s), ${report.summary.methodValidationFailures} method validation failure(s), ${report.summary.warnings} warning(s), ${report.summary.inconclusive} inconclusive`,
  );
  lines.push('');

  if (report.pairs.length === 0) {
    lines.push('No request-response pairs were supplied.');
    return lines.join('\n');
  }

  for (const pair of report.pairs) {
    const label = pair.label ? ` "${pair.label}"` : '';
    const method = pair.method ? ` method=${pair.method}` : '';
    const status = pair.valid ? 'PASS' : 'FAIL';
    lines.push(`[${status}] Pair #${pair.index}${label}${method}`);
    if (pair.requestId !== undefined || pair.responseId !== undefined) {
      lines.push(
        `  ids: request=${describeId(pair.requestId)} response=${describeId(pair.responseId)}`,
      );
    }
    if (pair.findings.length === 0) {
      lines.push('  No issues detected.');
    } else {
      for (const finding of pair.findings) {
        const path = finding.path ? ` (${finding.path})` : '';
        lines.push(`  - [${SEVERITY_LABELS[finding.severity]}] ${finding.code}${path}`);
        lines.push(`      ${finding.message}`);
        lines.push(`      Fix: ${finding.remediation}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

/**
 * Format an audit report as machine-readable JSON.
 */
export function formatAuditReportJson(report: AuditReport): string {
  return JSON.stringify(report, null, 2);
}

/**
 * Convenience helper: audit pairs and return the JSON report string.
 */
export function auditJsonRpcPairsToJson(
  pairs: RequestResponsePair[],
  options: AuditOptions = {},
): string {
  return formatAuditReportJson(auditJsonRpcPairs(pairs, options));
}

/**
 * Convenience helper: audit pairs and return the terminal report string.
 */
export function auditJsonRpcPairsToTerminal(
  pairs: RequestResponsePair[],
  options: AuditOptions = {},
): string {
  return formatAuditReportTerminal(auditJsonRpcPairs(pairs, options));
}