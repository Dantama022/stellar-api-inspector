import { StrKey } from '@stellar/stellar-sdk';
import { collectInteractiveCommand } from '../src/prompts/main-menu';
import { validateAccountId, validatePositiveInteger, validateUrl } from '../src/prompts/validators';

function mockInquirer(answers: unknown[]) {
  return {
    prompt: jest.fn().mockImplementation(() => Promise.resolve(answers.shift())),
  };
}

describe('interactive prompt routing', () => {
  it('routes Horizon menu selection to horizon command', async () => {
    const inquirer = mockInquirer([
      { action: 'horizon' },
      { url: 'https://horizon-testnet.stellar.org' },
    ]);

    const command = await collectInteractiveCommand(inquirer);
    expect(command).toEqual({
      command: 'horizon',
      args: ['https://horizon-testnet.stellar.org'],
      summary: 'stellar-api-inspector horizon https://horizon-testnet.stellar.org',
    });
  });

  it('routes operations inputs into operations command arguments', async () => {
    const account = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 3));
    const inquirer = mockInquirer([
      { action: 'operations' },
      {
        horizon: 'https://horizon-testnet.stellar.org',
        account,
        type: 'payment',
        limit: '25',
      },
    ]);

    const command = await collectInteractiveCommand(inquirer);
    expect(command?.command).toBe('operations');
    expect(command?.args).toContain('--account');
    expect(command?.args).toContain(account);
    expect(command?.args).toContain('--type');
    expect(command?.args).toContain('payment');
  });

  it('returns null for exit selection', async () => {
    const inquirer = mockInquirer([{ action: 'exit' }]);
    await expect(collectInteractiveCommand(inquirer)).resolves.toBeNull();
  });
});

describe('interactive validators', () => {
  it('validates URLs, account IDs, and positive integers', () => {
    const account = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 4));
    expect(validateUrl('https://horizon-testnet.stellar.org')).toBe(true);
    expect(validateUrl('not-a-url')).not.toBe(true);
    expect(validateAccountId(account)).toBe(true);
    expect(validateAccountId('bad')).not.toBe(true);
    expect(validatePositiveInteger('10')).toBe(true);
    expect(validatePositiveInteger('0')).not.toBe(true);
  });
});
