import { Command } from 'commander';
import fs from 'fs';
import { outputJson, outputJsonError } from '../../output/json';
import { auditHorizonPagination, formatPaginationAuditReport } from '../../services/horizon-pagination-completeness-audit';
import { auditEnvelopeSize, formatEnvelopeSizeReport, parseLimitSpec, SizeLimit } from '../../services/tx-envelope-size-audit';
import { auditSequenceConsumption, formatSequenceConsumptionReport } from '../../services/sequence-consumption-audit';
import { auditMemoEncoding, formatMemoEncodingReport } from '../../services/tx-memo-encoding-audit';

export function registerValrebAuditCommands(program: Command): void {
  program
    .command('horizon-pagination-audit <file>')
    .description('Audit saved Horizon pages or a retrieval manifest for pagination completeness (read-only)')
    .option('--json', 'Output as JSON')
    .action((file: string, options: { json?: boolean }) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (e) {
        const msg = `Cannot read or parse ${file}: ${e instanceof Error ? e.message : String(e)}`;
        if (options.json) outputJsonError(msg, 1);
        else process.stderr.write(msg + '\n');
        process.exit(1);
      }
      const report = auditHorizonPagination(parsed);
      if (options.json) outputJson(report);
      else process.stdout.write(formatPaginationAuditReport(report) + '\n');
      if (report.status === 'defects') process.exit(2);
    });

  program
    .command('tx-envelope-size <xdr>')
    .description('Measure transaction envelope XDR size and compare with explicitly supplied limits (read-only)')
    .option('--limit <name=bytes[:source]>', 'Infrastructure limit to compare (repeatable)', (v: string, p: string[]) => p.concat([v]), [] as string[])
    .option('--json', 'Output as JSON')
    .action((xdrInput: string, options: { json?: boolean; limit: string[] }) => {
      let limits: SizeLimit[];
      try {
        limits = options.limit.map(parseLimitSpec);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (options.json) outputJsonError(msg, 1);
        process.stderr.write(msg + '\n');
        process.exit(1);
      }
      const report = auditEnvelopeSize(xdrInput, limits);
      if (options.json) outputJson(report);
      else process.stdout.write(formatEnvelopeSizeReport(report) + '\n');
      if (report.status === 'invalid' || report.status === 'limit-exceeded') process.exit(2);
    });

  program
    .command('sequence-consumption <account>')
    .description('Summarize observed sequence-number consumption and throughput for an account (read-only)')
    .option('--horizon <url>', 'Horizon URL', 'https://horizon-testnet.stellar.org')
    .option('--start-time <iso>', 'Interval start time')
    .option('--end-time <iso>', 'Interval end time')
    .option('--start-ledger <n>', 'Interval start ledger', (v: string) => parseInt(v, 10))
    .option('--end-ledger <n>', 'Interval end ledger', (v: string) => parseInt(v, 10))
    .option('--max-pages <n>', 'Maximum pages to fetch', (v: string) => parseInt(v, 10))
    .option('--json', 'Output as JSON')
    .action(async (account: string, options: any) => {
      try {
        const report = await auditSequenceConsumption(options.horizon, account, {
          startTime: options.startTime, endTime: options.endTime,
          startLedger: options.startLedger, endLedger: options.endLedger, maxPages: options.maxPages,
        });
        if (options.json) outputJson(report);
        else process.stdout.write(formatSequenceConsumptionReport(report) + '\n');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (options.json) outputJsonError(msg, 1);
        process.stderr.write(msg + '\n');
        process.exit(1);
      }
    });

  program
    .command('tx-memo-encoding <xdr>')
    .description('Validate memo type and encoding of a transaction envelope (read-only)')
    .option('--json', 'Output as JSON')
    .action((xdrInput: string, options: { json?: boolean }) => {
      const report = auditMemoEncoding(xdrInput);
      if (options.json) outputJson(report);
      else process.stdout.write(formatMemoEncodingReport(report) + '\n');
      if (report.status !== 'valid') process.exit(2);
    });
}
