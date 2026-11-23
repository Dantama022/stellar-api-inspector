import { StrKey } from '@stellar/stellar-sdk';
import { existsSync, statSync } from 'fs';
import { validateHorizonUrl } from '../utils/urls';
import { validateSorobanUrl } from '../inspectors/soroban';
import { existsSync, statSync, accessSync, constants } from 'fs';

export function validateNonEmpty(value: string): true | string {
  return value.trim().length > 0 || 'Value is required';
}

export function validateUrl(value: string): true | string {
  const result = validateHorizonUrl(value);
  return result.valid || result.error || 'Invalid URL';
}

export function validateSorobanRpcUrl(value: string): true | string {
  const result = validateSorobanUrl(value);
  return result.valid || result.error || 'Invalid Soroban RPC URL';
}

export function validateAccountId(value: string): true | string {
  return StrKey.isValidEd25519PublicKey(value.trim()) || 'Invalid Stellar account ID';
}

export function validateContractIdPrompt(value: string): true | string {
  return StrKey.isValidContract(value.trim()) || 'Invalid Soroban contract ID';
}

export function validatePositiveInteger(value: string): true | string {
  const parsed = Number.parseInt(value, 10);
  return (Number.isInteger(parsed) && parsed > 0) || 'Enter a positive integer';
}

export function validateTransactionHash(value: string): true | string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return 'Transaction hash is required';
  }
  return /^[0-9a-fA-F]{64}$/.test(trimmed) || 'Invalid transaction hash (expected 64 hex characters)';
}

function validateReadableFilePath(value: string, label: string): true | string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return `${label} path is required`;
  }
  if (!existsSync(trimmed)) {
    return `${label} file does not exist: ${trimmed}`;
  }
  try {
    if (!statSync(trimmed).isFile()) {
      return `${label} path is not a file: ${trimmed}`;
    }
  } catch {
    return `Unable to read ${label.toLowerCase()} file: ${trimmed}`;
  }
  try {
    accessSync(trimmed, constants.R_OK);
  } catch {
    return `${label} file is not readable: ${trimmed}`;
  }
  return true;
}

export function validateSnapshotFilePath(value: string): true | string {
  return validateReadableFilePath(value, 'Snapshot');
}

export function validateEventQueryFilePath(value: string): true | string {
  return validateReadableFilePath(value, 'Event query');
}

export function validateMemoPrivacyRulesFilePath(value: string): true | string {
  return validateReadableFilePath(value, 'Memo privacy rules');
}

export function validateMetricsSnapshotFilePath(value: string): true | string {
  return validateReadableFilePath(value, 'Metrics snapshot');
}

export function validateMetricsExportFilePath(value: string): true | string {
  return validateReadableFilePath(value, 'Metrics export');
}

export function validateScpDiagnosticFilePath(value: string): true | string {
  return validateReadableFilePath(value, 'SCP diagnostic');
}

export function validateStellarCoreConfigFilePath(value: string): true | string {
  return validateReadableFilePath(value, 'Stellar Core config');
}

export function validateListeningInterfaceFilePath(value: string): true | string {
  return validateReadableFilePath(value, 'Listening interface diagnostic');
}