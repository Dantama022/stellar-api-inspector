import { Horizon } from '@stellar/stellar-sdk';
import { normalizeHorizonUrl } from '../utils/urls';

export interface HorizonOperationRecord {
  id: string;
  transaction_hash?: string;
  source_account?: string;
  type: string;
  created_at: string;
  [key: string]: unknown;
}

export async function fetchTransaction(
  horizonUrl: string,
  hash: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const normalizedUrl = normalizeHorizonUrl(horizonUrl);
  const server = new Horizon.Server(normalizedUrl);
  return server.transactions().transaction(hash).call();
}

export async function fetchOperationsForTransaction(
  horizonUrl: string,
  hash: string,
): Promise<HorizonOperationRecord[]> {
  const normalizedUrl = normalizeHorizonUrl(horizonUrl);
  const server = new Horizon.Server(normalizedUrl);
  const response = await server.operations().forTransaction(hash).call();
  return (response.records as unknown as HorizonOperationRecord[]) ?? [];
}
