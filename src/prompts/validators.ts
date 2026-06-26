import { StrKey } from '@stellar/stellar-sdk';
import { validateHorizonUrl } from '../utils/urls';
import { validateSorobanUrl } from '../inspectors/soroban';

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
