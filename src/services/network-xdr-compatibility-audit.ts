import { Networks, TransactionBuilder } from '@stellar/stellar-sdk';

const PASSPHRASES: Record<string, string> = { public: Networks.PUBLIC, testnet: Networks.TESTNET, futurenet: Networks.FUTURENET };

export function auditNetworkXdr(envelopeXdr: string, selectedNetwork: keyof typeof PASSPHRASES | string, declaredNetwork?: string) {
  const passphrase = PASSPHRASES[selectedNetwork] ?? selectedNetwork;
  const findings: string[] = [];
  let transaction: any = null;
  try { transaction = TransactionBuilder.fromXDR(envelopeXdr, passphrase); } catch (error) { findings.push(error instanceof Error ? `Malformed or unsupported transaction envelope: ${error.message}` : 'Malformed or unsupported transaction envelope'); }
  if (declaredNetwork && declaredNetwork !== selectedNetwork && declaredNetwork !== passphrase) findings.push(`Declared network ${declaredNetwork} differs from selected network ${selectedNetwork}`);
  const inspected = transaction?.innerTransaction ?? transaction;
  return { structurallyDecodable: transaction !== null, selectedNetwork, declaredNetwork: declaredNetwork ?? null, envelopeType: transaction && 'innerTransaction' in transaction ? 'fee_bump' : transaction ? 'transaction' : null, operationCount: inspected?.operations?.length ?? null, signatures: transaction?.signatures?.length ?? null, valid: findings.length === 0, findings, limitation: 'Successful XDR decoding cannot prove network membership or submission validity; network context primarily affects signature payloads.' };
}
