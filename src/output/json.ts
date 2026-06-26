/**
 * Shared JSON output utilities for machine-readable CLI output.
 *
 * When --json mode is active:
 * - All structured results are serialized through this module
 * - Errors are represented as a consistent { error, code } envelope
 * - Progress and diagnostic messages go to stderr only
 */

export interface JsonSuccessEnvelope<T> {
  ok: true;
  data: T;
}

export interface JsonErrorEnvelope {
  ok: false;
  error: string;
  code: number;
}

export type JsonEnvelope<T> = JsonSuccessEnvelope<T> | JsonErrorEnvelope;

/**
 * Serialize a successful result to stdout as a JSON envelope.
 * Does NOT call process.exit — caller is responsible for exit codes.
 */
export function outputJson<T>(data: T): void {
  const envelope: JsonSuccessEnvelope<T> = { ok: true, data };
  process.stdout.write(JSON.stringify(envelope, null, 2) + '\n');
}

/**
 * Serialize an error to stdout as a JSON error envelope, then exit.
 * Using stdout (not stderr) ensures `--json` consumers always get
 * machine-readable output on the same stream.
 */
export function outputJsonError(message: string, exitCode = 1): never {
  const envelope: JsonErrorEnvelope = { ok: false, error: message, code: exitCode };
  process.stdout.write(JSON.stringify(envelope, null, 2) + '\n');
  process.exit(exitCode);
}
