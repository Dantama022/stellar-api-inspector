import {
  validateAccountId,
  validateContractIdPrompt,
  validateNonEmpty,
  validatePositiveInteger,
  validateSorobanRpcUrl,
  validateUrl,
} from './validators';

export type InteractiveAction =
  | 'horizon'
  | 'soroban'
  | 'account'
  | 'account-snapshot-audit'
  | 'health'
  | 'ledger'
  | 'asset'
  | 'fees'
  | 'decode'
  | 'operations'
  | 'payment-reference-audit'
  | 'contract'
  | 'soroban-tx'
  | 'soroban-event-query'
  | 'memo-privacy-audit'
  | 'trades'
  | 'sponsorship'
  | 'network-compat'
  | 'entry-ownership'
  | 'sep30-quorum'
  | 'core-metrics'
  | 'core-metrics-validate'
  | 'core-scp-state'
  | 'core-admin-endpoints'
  | 'exit';

export interface InteractiveCommand {
  command: string;
  args: string[];
  summary: string;
}

interface PromptModule {
  prompt<T>(questions: unknown): Promise<T>;
}

export async function runInteractiveMode(
  argv: string[],
  execute: (argv: string[]) => Promise<void> | void,
): Promise<void> {
  const inquirer = await loadInquirer();
  const command = await collectInteractiveCommand(inquirer);

  if (!command) {
    process.stderr.write('Interactive mode cancelled.\n');
    return;
  }

  const confirmation = await inquirer.prompt<{ confirmed: boolean }>([
    {
      type: 'confirm',
      name: 'confirmed',
      message: `Run: ${command.summary}?`,
      default: true,
    },
  ]);

  if (!confirmation.confirmed) {
    process.stderr.write('Command cancelled.\n');
    return;
  }

  await execute([...argv.slice(0, 2), command.command, ...command.args]);
}

export async function collectInteractiveCommand(
  inquirer: PromptModule,
): Promise<InteractiveCommand | null> {
  const menu = await inquirer.prompt<{ action: InteractiveAction }>([
    {
      type: 'list',
      name: 'action',
      message: 'Select an inspection',
      choices: [
        { name: 'Inspect Horizon Endpoint', value: 'horizon' },
        { name: 'Inspect Soroban Endpoint', value: 'soroban' },
        { name: 'Audit Account', value: 'account' },
        { name: 'Account Snapshot Consistency Audit', value: 'account-snapshot-audit' },
        { name: 'Multi-Endpoint Health Dashboard', value: 'health' },
        { name: 'Inspect Ledger Header', value: 'ledger' },
        { name: 'Inspect Asset', value: 'asset' },
        { name: 'Network Fee Statistics', value: 'fees' },
        { name: 'Decode Transaction XDR', value: 'decode' },
        { name: 'Operations History', value: 'operations' },
        { name: 'Payment Reference Audit', value: 'payment-reference-audit' },
        { name: 'Inspect Soroban Contract', value: 'contract' },
        { name: 'Inspect Soroban Transaction', value: 'soroban-tx' },
        { name: 'Validate Soroban Event Query', value: 'soroban-event-query' },
        { name: 'Transaction Memo Privacy Audit', value: 'memo-privacy-audit' },
        { name: 'Market Trade History', value: 'trades' },
        { name: 'Sponsorship Lifecycle Audit', value: 'sponsorship' },
        { name: 'Network Fee & Protocol Compatibility Audit', value: 'network-compat' },
        { name: 'Ledger-Entry Ownership Audit', value: 'entry-ownership' },
        { name: 'SEP-30 Recovery Signer Quorum Audit', value: 'sep30-quorum' },
        { name: 'Stellar Core Metrics Inspection', value: 'core-metrics' },
        { name: 'Stellar Core Metrics Export Validation', value: 'core-metrics-validate' },
        { name: 'Stellar Core SCP Consensus State Inspection', value: 'core-scp-state' },
        { name: 'Stellar Core Administrative Endpoint Audit', value: 'core-admin-endpoints' },
        { name: 'Exit', value: 'exit' },
      ],
    },
  ]);

  switch (menu.action) {
    case 'horizon':
      return collectHorizonCommand(inquirer);
    case 'soroban':
      return collectSorobanCommand(inquirer);
    case 'account':
      return collectAccountCommand(inquirer);
    case 'account-snapshot-audit':
      return collectAccountSnapshotAuditCommand(inquirer);
    case 'health':
      return collectHealthCommand(inquirer);
    case 'ledger':
      return collectLedgerCommand(inquirer);
    case 'asset':
      return collectAssetCommand(inquirer);
    case 'fees':
      return collectFeesCommand(inquirer);
    case 'decode':
      return collectDecodeCommand(inquirer);
    case 'operations':
      return collectOperationsCommand(inquirer);
    case 'payment-reference-audit':
      return collectPaymentReferenceAuditCommand(inquirer);
    case 'contract':
      return collectContractCommand(inquirer);
    case 'soroban-tx':
      return collectSorobanTxCommand(inquirer);
    case 'soroban-event-query':
      return collectSorobanEventQueryCommand(inquirer);
    case 'memo-privacy-audit':
      return collectMemoPrivacyAuditCommand(inquirer);
    case 'trades':
      return collectTradesCommand(inquirer);
    case 'sponsorship':
      return collectSponsorshipCommand(inquirer);
    case 'network-compat':
      return collectNetworkCompatCommand(inquirer);
    case 'entry-ownership':
      return collectEntryOwnershipCommand(inquirer);
    case 'sep30-quorum':
      return collectSep30QuorumCommand(inquirer);
    case 'core-metrics':
      return collectCoreMetricsCommand(inquirer);
    case 'core-metrics-validate':
      return collectCoreMetricsValidateCommand(inquirer);
    case 'core-scp-state':
      return collectCoreScpStateCommand(inquirer);
    case 'core-admin-endpoints':
      return collectCoreAdminEndpointsCommand(inquirer);
    case 'exit':
      return null;
  }
}

async function collectHorizonCommand(inquirer: PromptModule): Promise<InteractiveCommand> {
  const answers = await inquirer.prompt<{ url: string }>([
    {
      type: 'input',
      name: 'url',
      message: 'Horizon endpoint URL',
      default: 'https://horizon-testnet.stellar.org',
      validate: validateUrl,
    },
  ]);

  return {
    command: 'horizon',
    args: [answers.url],
    summary: `stellar-api-inspector horizon ${answers.url}`,
  };
}

async function collectSorobanCommand(inquirer: PromptModule): Promise<InteractiveCommand> {
  const answers = await inquirer.prompt<{ url: string }>([
    {
      type: 'input',
      name: 'url',
      message: 'Soroban RPC URL',
      default: 'https://soroban-testnet.stellar.org',
      validate: validateSorobanRpcUrl,
    },
  ]);

  return {
    command: 'soroban',
    args: [answers.url],
    summary: `stellar-api-inspector soroban ${answers.url}`,
  };
}

async function collectAccountCommand(inquirer: PromptModule): Promise<InteractiveCommand> {
  const answers = await inquirer.prompt<{ accountId: string; horizon: string }>([
    {
      type: 'input',
      name: 'accountId',
      message: 'Account ID',
      validate: validateAccountId,
    },
    {
      type: 'input',
      name: 'horizon',
      message: 'Horizon endpoint URL',
      default: 'https://horizon-testnet.stellar.org',
      validate: validateUrl,
    },
  ]);

  return {
    command: 'account',
    args: [answers.accountId, '--horizon', answers.horizon],
    summary: `stellar-api-inspector account ${answers.accountId} --horizon ${answers.horizon}`,
  };
}

async function collectAccountSnapshotAuditCommand(
  inquirer: PromptModule,
): Promise<InteractiveCommand> {
  const answers = await inquirer.prompt<{ snapshots: string; horizon: string }>([
    {
      type: 'input',
      name: 'snapshots',
      message: 'Account snapshot files or responses, comma-separated',
      validate: (value: string) => {
        const snapshots = splitCsv(value);
        if (snapshots.length < 2) return 'At least two snapshots are required';
        return true;
      },
    },
    {
      type: 'input',
      name: 'horizon',
      message: 'Optional Horizon endpoint URL',
      validate: (value: string) => value.trim() === '' || validateUrl(value),
    },
  ]);

  const snapshots = splitCsv(answers.snapshots);
  const args = [...snapshots];
  if (answers.horizon.trim()) args.push('--horizon', answers.horizon.trim());

  return {
    command: 'account-snapshot-audit',
    args,
    summary: `stellar-api-inspector account-snapshot-audit ${snapshots.join(' ')}`,
  };
}

async function collectHealthCommand(inquirer: PromptModule): Promise<InteractiveCommand> {
  const answers = await inquirer.prompt<{ urls: string }>([
    {
      type: 'input',
      name: 'urls',
      message: 'Horizon endpoint URLs, comma-separated',
      validate: (value: string) => {
        const urls = splitCsv(value);
        if (urls.length === 0) return 'At least one URL is required';
        const invalid = urls.find((url) => validateUrl(url) !== true);
        return invalid ? `Invalid URL: ${invalid}` : true;
      },
    },
  ]);

  const urls = splitCsv(answers.urls);
  return {
    command: 'health',
    args: urls,
    summary: `stellar-api-inspector health ${urls.join(' ')}`,
  };
}

async function collectDecodeCommand(inquirer: PromptModule): Promise<InteractiveCommand> {
  const answers = await inquirer.prompt<{ xdr: string; network: string }>([
    {
      type: 'input',
      name: 'xdr',
      message: 'Transaction envelope XDR',
      validate: validateNonEmpty,
    },
    {
      type: 'input',
      name: 'network',
      message: 'Network passphrase or alias',
      default: 'testnet',
    },
  ]);

  return {
    command: 'decode',
    args: [answers.xdr, '--network', answers.network],
    summary: 'stellar-api-inspector decode <xdr>',
  };
}

async function collectOperationsCommand(inquirer: PromptModule): Promise<InteractiveCommand> {
  const answers = await inquirer.prompt<{
    horizon: string;
    account: string;
    type: string;
    limit: string;
  }>([
    {
      type: 'input',
      name: 'horizon',
      message: 'Horizon endpoint URL',
      default: 'https://horizon-testnet.stellar.org',
      validate: validateUrl,
    },
    {
      type: 'input',
      name: 'account',
      message: 'Optional account filter',
      validate: (value: string) => value.trim() === '' || validateAccountId(value),
    },
    {
      type: 'input',
      name: 'type',
      message: 'Optional operation type filter',
    },
    {
      type: 'input',
      name: 'limit',
      message: 'Result limit',
      default: '10',
      validate: validatePositiveInteger,
    },
  ]);

  const args = ['--horizon', answers.horizon, '--limit', answers.limit];
  if (answers.account.trim()) args.push('--account', answers.account.trim());
  if (answers.type.trim()) args.push('--type', answers.type.trim());

  return {
    command: 'operations',
    args,
    summary: `stellar-api-inspector operations ${args.join(' ')}`,
  };
}

async function collectPaymentReferenceAuditCommand(
  inquirer: PromptModule,
): Promise<InteractiveCommand> {
  const answers = await inquirer.prompt<{
    reference: string;
    horizon: string;
    account: string;
    asset: string;
    amount: string;
    since: string;
  }>([
    {
      type: 'input',
      name: 'reference',
      message: 'Transaction hash or application-level payment reference',
      validate: validateNonEmpty,
    },
    {
      type: 'input',
      name: 'horizon',
      message: 'Horizon endpoint URL',
      default: 'https://horizon-testnet.stellar.org',
      validate: validateUrl,
    },
    {
      type: 'input',
      name: 'account',
      message: 'Optional account filter',
      validate: (value: string) => value.trim() === '' || validateAccountId(value),
    },
    {
      type: 'input',
      name: 'asset',
      message: 'Optional expected asset (e.g. XLM or CODE:ISSUER)',
    },
    {
      type: 'input',
      name: 'amount',
      message: 'Optional expected amount',
    },
    {
      type: 'input',
      name: 'since',
      message: 'Optional time window start (ISO 8601)',
    },
  ]);

  const args = [answers.reference.trim(), '--horizon', answers.horizon];
  if (answers.account.trim()) args.push('--account', answers.account.trim());
  if (answers.asset.trim()) args.push('--asset', answers.asset.trim());
  if (answers.amount.trim()) args.push('--amount', answers.amount.trim());
  if (answers.since.trim()) args.push('--since', answers.since.trim());

  return {
    command: 'payment-reference-audit',
    args,
    summary: `stellar-api-inspector payment-reference-audit ${answers.reference.trim()} --horizon ${answers.horizon}`,
  };
}

async function collectContractCommand(inquirer: PromptModule): Promise<InteractiveCommand> {
  const answers = await inquirer.prompt<{
    contractId: string;
    rpc: string;
    ttlWarning: string;
  }>([
    {
      type: 'input',
      name: 'contractId',
      message: 'Soroban contract ID',
      validate: validateContractIdPrompt,
    },
    {
      type: 'input',
      name: 'rpc',
      message: 'Soroban RPC URL',
      default: 'https://soroban-testnet.stellar.org',
      validate: validateSorobanRpcUrl,
    },
    {
      type: 'input',
      name: 'ttlWarning',
      message: 'TTL warning threshold in ledgers',
      default: '17280',
      validate: validatePositiveInteger,
    },
  ]);

  return {
    command: 'contract',
    args: [answers.contractId, '--rpc', answers.rpc, '--ttl-warning-ledgers', answers.ttlWarning],
    summary: `stellar-api-inspector contract ${answers.contractId} --rpc ${answers.rpc}`,
  };
}

async function collectSep10AuditCommand(inquirer: PromptModule): Promise<InteractiveCommand> {
  const answers = await inquirer.prompt<{
    xdr: string;
    serverAccount: string;
    clientAccount: string;
    network: string;
  }>([
    {
      type: 'input',
      name: 'xdr',
      message: 'SEP-10 challenge transaction envelope XDR',
      validate: validateNonEmpty,
    },
    {
      type: 'input',
      name: 'serverAccount',
      message: 'Expected server account ID',
      validate: validateAccountId,
    },
    {
      type: 'input',
      name: 'clientAccount',
      message: 'Expected client account ID',
      validate: validateAccountId,
    },
    {
      type: 'input',
      name: 'network',
      message: 'Network passphrase or alias',
      default: 'testnet',
    },
  ]);

  const args = [
    answers.xdr,
    '--server-account',
    answers.serverAccount,
    '--client-account',
    answers.clientAccount,
    '--network',
    answers.network,
  ];

  return {
    command: 'sep10-audit',
    args,
    summary: `stellar-api-inspector sep10-audit <xdr> --server-account ${answers.serverAccount} --client-account ${answers.clientAccount} --network ${answers.network}`,
  };
}

async function collectPaymentFlowCommand(inquirer: PromptModule): Promise<InteractiveCommand> {
  const answers = await inquirer.prompt<{
    accountId: string;
    horizon: string;
    from: string;
    to: string;
    limit: string;
  }>([
    {
      type: 'input',
      name: 'accountId',
      message: 'Account ID',
      validate: validateAccountId,
    },
    {
      type: 'input',
      name: 'horizon',
      message: 'Horizon endpoint URL',
      default: 'https://horizon-testnet.stellar.org',
      validate: validateUrl,
    },
    {
      type: 'input',
      name: 'from',
      message: 'Optional start time or ledger (leave blank for unbounded)',
    },
    {
      type: 'input',
      name: 'to',
      message: 'Optional end time or ledger (leave blank for unbounded)',
    },
    {
      type: 'input',
      name: 'limit',
      message: 'Maximum records to retrieve',
      default: '200',
      validate: validatePositiveInteger,
    },
  ]);

  const args = [answers.accountId, '--horizon', answers.horizon, '--limit', answers.limit];
  if (answers.from.trim()) args.push('--from', answers.from.trim());
  if (answers.to.trim()) args.push('--to', answers.to.trim());

  return {
    command: 'payment-flow',
    args,
    summary: `stellar-api-inspector payment-flow ${answers.accountId} --horizon ${answers.horizon}`,
  };
}

async function collectEventRetentionCommand(inquirer: PromptModule): Promise<InteractiveCommand> {
  const answers = await inquirer.prompt<{ manifest: string }>([
    {
      type: 'input',
      name: 'manifest',
      message: 'Path to saved event response pages or retrieval manifest',
      validate: validateNonEmpty,
    },
  ]);

  return {
    command: 'event-retention',
    args: [answers.manifest.trim()],
    summary: `stellar-api-inspector event-retention ${answers.manifest.trim()}`,
  };
}

async function collectTxConsistencyCommand(inquirer: PromptModule): Promise<InteractiveCommand> {
  const answers = await inquirer.prompt<{ response: string; network: string }>([
    {
      type: 'input',
      name: 'response',
      message: 'Path to Horizon transaction response JSON file',
      validate: validateNonEmpty,
    },
    {
      type: 'input',
      name: 'network',
      message: 'Network passphrase or alias',
      default: 'testnet',
    },
  ]);

  return {
    command: 'tx-consistency',
    args: [answers.response.trim(), '--network', answers.network],
    summary: `stellar-api-inspector tx-consistency ${answers.response.trim()} --network ${answers.network}`,
  };
}

async function loadInquirer(): Promise<PromptModule> {
  const imported = (await import('inquirer')) as unknown as {
    default?: PromptModule;
  } & PromptModule;
  return imported.default ?? imported;
}

function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

async function collectLedgerCommand(inquirer: PromptModule): Promise<InteractiveCommand> {
  const answers = await inquirer.prompt<{ sequence: string; horizon: string }>([
    {
      type: 'input',
      name: 'sequence',
      message: 'Ledger sequence',
      validate: validatePositiveInteger,
    },
    {
      type: 'input',
      name: 'horizon',
      message: 'Horizon endpoint URL',
      default: 'https://horizon-testnet.stellar.org',
      validate: validateUrl,
    },
  ]);

  return {
    command: 'ledger',
    args: [answers.sequence, '--horizon', answers.horizon],
    summary: `stellar-api-inspector ledger ${answers.sequence} --horizon ${answers.horizon}`,
  };
}

async function collectAssetCommand(inquirer: PromptModule): Promise<InteractiveCommand> {
  const answers = await inquirer.prompt<{ asset: string; horizon: string }>([
    {
      type: 'input',
      name: 'asset',
      message: 'Asset CODE:ISSUER',
      validate: validateNonEmpty,
    },
    {
      type: 'input',
      name: 'horizon',
      message: 'Horizon endpoint URL',
      default: 'https://horizon-testnet.stellar.org',
      validate: validateUrl,
    },
  ]);

  return {
    command: 'asset',
    args: [answers.asset, '--horizon', answers.horizon],
    summary: `stellar-api-inspector asset ${answers.asset} --horizon ${answers.horizon}`,
  };
}

async function collectFeesCommand(inquirer: PromptModule): Promise<InteractiveCommand> {
  const answers = await inquirer.prompt<{ horizon: string }>([
    {
      type: 'input',
      name: 'horizon',
      message: 'Horizon endpoint URL',
      default: 'https://horizon-testnet.stellar.org',
      validate: validateUrl,
    },
  ]);

  return {
    command: 'fees',
    args: ['--horizon', answers.horizon],
    summary: `stellar-api-inspector fees --horizon ${answers.horizon}`,
  };
}

async function collectSorobanTxCommand(inquirer: PromptModule): Promise<InteractiveCommand> {
  const answers = await inquirer.prompt<{ hash: string; rpc: string }>([
    {
      type: 'input',
      name: 'hash',
      message: 'Transaction hash (64 hex characters)',
      validate: (value: string) =>
        /^[0-9a-fA-F]{64}$/.test(value.trim()) || 'Enter a valid 64-character hex transaction hash',
    },
    {
      type: 'input',
      name: 'rpc',
      message: 'Soroban RPC URL',
      default: 'https://soroban-testnet.stellar.org',
      validate: validateSorobanRpcUrl,
    },
  ]);

  return {
    command: 'soroban-tx',
    args: [answers.hash.trim(), '--rpc', answers.rpc],
    summary: `stellar-api-inspector soroban-tx ${answers.hash.trim()} --rpc ${answers.rpc}`,
  };
}

async function collectSorobanEventQueryCommand(
  inquirer: PromptModule,
): Promise<InteractiveCommand> {
  const answers = await inquirer.prompt<{ query: string; rpc: string }>([
    {
      type: 'input',
      name: 'query',
      message: 'Saved event query configuration file (JSON)',
      validate: validateNonEmpty,
    },
    {
      type: 'input',
      name: 'rpc',
      message: 'Optional Soroban RPC URL for endpoint compatibility checks',
      validate: (value: string) => value.trim() === '' || validateSorobanRpcUrl(value),
    },
  ]);

  const args = [answers.query.trim()];
  if (answers.rpc.trim()) args.push('--rpc', answers.rpc.trim());

  return {
    command: 'soroban-event-query',
    args,
    summary: `stellar-api-inspector soroban-event-query ${answers.query.trim()}`,
  };
}

async function collectMemoPrivacyAuditCommand(
  inquirer: PromptModule,
): Promise<InteractiveCommand> {
  const answers = await inquirer.prompt<{
    transaction: string;
    network: string;
    rules: string;
    showMemo: string;
  }>([
    {
      type: 'input',
      name: 'transaction',
      message: 'Transaction envelope XDR or transaction record file',
      validate: validateNonEmpty,
    },
    {
      type: 'input',
      name: 'network',
      message: 'Network passphrase or alias',
      default: 'testnet',
    },
    {
      type: 'input',
      name: 'rules',
      message: 'Optional custom privacy rules file (JSON)',
    },
    {
      type: 'input',
      name: 'showMemo',
      message: 'Display decoded memo contents? (yes/no)',
      default: 'no',
      validate: (value: string) =>
        ['yes', 'no', 'y', 'n', ''].includes(value.trim().toLowerCase()) ||
        'Enter yes or no',
    },
  ]);

  const args = [answers.transaction.trim(), '--network', answers.network];
  if (answers.rules.trim()) args.push('--rules', answers.rules.trim());
  if (['yes', 'y'].includes(answers.showMemo.trim().toLowerCase())) {
    args.push('--show-memo');
  }

  return {
    command: 'memo-privacy-audit',
    args,
    summary: `stellar-api-inspector memo-privacy-audit <transaction> --network ${answers.network}`,
  };
}

async function collectTradesCommand(inquirer: PromptModule): Promise<InteractiveCommand> {
  const answers = await inquirer.prompt<{
    baseAsset: string;
    counterAsset: string;
    horizon: string;
    limit: string;
  }>([
    {
      type: 'input',
      name: 'baseAsset',
      message: 'Base asset (e.g. XLM or CODE:ISSUER)',
      validate: validateNonEmpty,
    },
    {
      type: 'input',
      name: 'counterAsset',
      message: 'Counter asset (e.g. USDC:ISSUER)',
      validate: validateNonEmpty,
    },
    {
      type: 'input',
      name: 'horizon',
      message: 'Horizon endpoint URL',
      default: 'https://horizon-testnet.stellar.org',
      validate: validateUrl,
    },
    {
      type: 'input',
      name: 'limit',
      message: 'Number of trades to fetch',
      default: '20',
      validate: validatePositiveInteger,
    },
  ]);

  const args = [
    answers.baseAsset,
    answers.counterAsset,
    '--horizon',
    answers.horizon,
    '--limit',
    answers.limit,
  ];

  return {
    command: 'trades',
    args,
    summary: `stellar-api-inspector trades ${answers.baseAsset} ${answers.counterAsset} --horizon ${answers.horizon} --limit ${answers.limit}`,
  };
}

async function collectSponsorshipCommand(inquirer: PromptModule): Promise<InteractiveCommand> {
  const answers = await inquirer.prompt<{ accountId: string; horizon: string }>([
    {
      type: 'input',
      name: 'accountId',
      message: 'Account ID',
      validate: validateAccountId,
    },
    {
      type: 'input',
      name: 'horizon',
      message: 'Horizon endpoint URL',
      default: 'https://horizon-testnet.stellar.org',
      validate: validateUrl,
    },
  ]);

  return {
    command: 'sponsorship',
    args: [answers.accountId, '--horizon', answers.horizon],
    summary: `stellar-api-inspector sponsorship ${answers.accountId} --horizon ${answers.horizon}`,
  };
}

async function collectNetworkCompatCommand(inquirer: PromptModule): Promise<InteractiveCommand> {
  const answers = await inquirer.prompt<{ horizon: string; rpc: string }>([
    {
      type: 'input',
      name: 'horizon',
      message: 'Horizon endpoint URL',
      default: 'https://horizon-testnet.stellar.org',
      validate: validateUrl,
    },
    {
      type: 'input',
      name: 'rpc',
      message: 'Optional Soroban RPC URL',
      validate: (value: string) => value.trim() === '' || validateSorobanRpcUrl(value),
    },
  ]);

  const args = ['--horizon', answers.horizon];
  if (answers.rpc.trim()) args.push('--rpc', answers.rpc.trim());

  return {
    command: 'network-compat',
    args,
    summary: `stellar-api-inspector network-compat ${args.join(' ')}`,
  };
}

async function collectEntryOwnershipCommand(inquirer: PromptModule): Promise<InteractiveCommand> {
  const answers = await inquirer.prompt<{ accountId: string; horizon: string }>([
    {
      type: 'input',
      name: 'accountId',
      message: 'Account ID',
      validate: validateAccountId,
    },
    {
      type: 'input',
      name: 'horizon',
      message: 'Horizon endpoint URL',
      default: 'https://horizon-testnet.stellar.org',
      validate: validateUrl,
    },
  ]);

  return {
    command: 'entry-ownership',
    args: [answers.accountId, '--horizon', answers.horizon],
    summary: `stellar-api-inspector entry-ownership ${answers.accountId} --horizon ${answers.horizon}`,
  };
}

async function collectSep30QuorumCommand(inquirer: PromptModule): Promise<InteractiveCommand> {
  const answers = await inquirer.prompt<{
    accountId: string;
    recoveryFile: string;
    horizon: string;
  }>([
    {
      type: 'input',
      name: 'accountId',
      message: 'Account ID',
      validate: validateAccountId,
    },
    {
      type: 'input',
      name: 'recoveryFile',
      message: 'Path to SEP-30 recovery account response file',
      validate: validateNonEmpty,
    },
    {
      type: 'input',
      name: 'horizon',
      message: 'Horizon endpoint URL',
      default: 'https://horizon-testnet.stellar.org',
      validate: validateUrl,
    },
  ]);

  return {
    command: 'sep30-quorum',
    args: [answers.accountId, '--recovery-file', answers.recoveryFile, '--horizon', answers.horizon],
    summary: `stellar-api-inspector sep30-quorum ${answers.accountId} --recovery-file ${answers.recoveryFile} --horizon ${answers.horizon}`,
  };
}

async function collectCoreMetricsCommand(inquirer: PromptModule): Promise<InteractiveCommand> {
  const answers = await inquirer.prompt<{
    snapshots: string;
    thresholds: string;
    format: string;
  }>([
    {
      type: 'input',
      name: 'snapshots',
      message: 'Prometheus metrics snapshot files, comma-separated',
      validate: (value: string) => {
        const snapshots = splitCsv(value);
        if (snapshots.length === 0) return 'At least one snapshot file is required';
        return true;
      },
    },
    {
      type: 'input',
      name: 'thresholds',
      message: 'Optional thresholds file (JSON)',
    },
    {
      type: 'list',
      name: 'format',
      message: 'Report format',
      choices: [
        { name: 'Human-readable', value: 'text' },
        { name: 'JSON', value: 'json' },
      ],
      default: 'text',
    },
  ]);

  const snapshots = splitCsv(answers.snapshots);
  const args = [...snapshots];
  if (answers.thresholds.trim()) args.push('--thresholds', answers.thresholds.trim());
  if (answers.format === 'json') args.push('--json');

  return {
    command: 'core-metrics',
    args,
    summary: `stellar-api-inspector core-metrics ${snapshots.join(' ')}`,
  };
}

async function collectCoreMetricsValidateCommand(
  inquirer: PromptModule,
): Promise<InteractiveCommand> {
  const answers = await inquirer.prompt<{ files: string; format: string }>([
    {
      type: 'input',
      name: 'files',
      message: 'Prometheus metrics export files, comma-separated',
      validate: (value: string) => {
        const files = splitCsv(value);
        if (files.length === 0) return 'At least one export file is required';
        return true;
      },
    },
    {
      type: 'list',
      name: 'format',
      message: 'Report format',
      choices: [
        { name: 'Human-readable', value: 'text' },
        { name: 'JSON', value: 'json' },
      ],
      default: 'text',
    },
  ]);

  const files = splitCsv(answers.files);
  const args = [...files];
  if (answers.format === 'json') args.push('--json');

  return {
    command: 'core-metrics-validate',
    args,
    summary: `stellar-api-inspector core-metrics-validate ${files.join(' ')}`,
  };
}

async function collectCoreScpStateCommand(inquirer: PromptModule): Promise<InteractiveCommand> {
  const answers = await inquirer.prompt<{ snapshots: string; format: string }>([
    {
      type: 'input',
      name: 'snapshots',
      message: 'SCP diagnostic snapshot files, comma-separated',
      validate: (value: string) => {
        const snapshots = splitCsv(value);
        if (snapshots.length === 0) return 'At least one snapshot file is required';
        return true;
      },
    },
    {
      type: 'list',
      name: 'format',
      message: 'Report format',
      choices: [
        { name: 'Human-readable', value: 'text' },
        { name: 'JSON', value: 'json' },
      ],
      default: 'text',
    },
  ]);

  const snapshots = splitCsv(answers.snapshots);
  const args = [...snapshots];
  if (answers.format === 'json') args.push('--json');

  return {
    command: 'core-scp-state',
    args,
    summary: `stellar-api-inspector core-scp-state ${snapshots.join(' ')}`,
  };
}

async function collectCoreAdminEndpointsCommand(
  inquirer: PromptModule,
): Promise<InteractiveCommand> {
  const answers = await inquirer.prompt<{
    config: string;
    listening: string;
    format: string;
  }>([
    {
      type: 'input',
      name: 'config',
      message: 'Path to Stellar Core configuration file',
      validate: validateNonEmpty,
    },
    {
      type: 'input',
      name: 'listening',
      message: 'Optional listening-interface diagnostic file',
    },
    {
      type: 'list',
      name: 'format',
      message: 'Report format',
      choices: [
        { name: 'Human-readable', value: 'text' },
        { name: 'JSON', value: 'json' },
      ],
      default: 'text',
    },
  ]);

  const args = [answers.config.trim()];
  if (answers.listening.trim()) args.push('--listening', answers.listening.trim());
  if (answers.format === 'json') args.push('--json');

  return {
    command: 'core-admin-endpoints',
    args,
    summary: `stellar-api-inspector core-admin-endpoints ${answers.config.trim()}`,
  };
}
