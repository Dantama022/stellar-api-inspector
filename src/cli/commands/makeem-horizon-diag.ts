import { Command } from 'commander';
import { diagnoseHorizonCache, formatCacheDiagnosticReport } from '../../services/mk-horizon-cache-diagnostics';

function emitMk(data: unknown, json: boolean | undefined, text: string): void {
  process.stdout.write((json ? JSON.stringify({ ok: true, data }, null, 2) : text) + '\n');
}

export function registerMakeemHorizonDiagCommands(program: Command): void {
  program
    .command('horizon-cache-diagnostics [endpoint]')
    .description('Inspect Horizon HTTP cache headers and freshness metadata (read-only)')
    .option('--repeat <n>', 'Number of samples (max 5)', '1')
    .option('--interval <ms>', 'Delay between samples in ms (min 1000)', '2000')
    .option('--timeout <ms>', 'Request timeout in ms', '10000')
    .option('-j, --json', 'Output raw JSON')
    .action(async (endpoint: string | undefined, o: { repeat: string; interval: string; timeout: string; json?: boolean }) => {
      const report = await diagnoseHorizonCache(endpoint ?? 'https://horizon-testnet.stellar.org/', {
        repeat: parseInt(o.repeat, 10) || 1,
        intervalMs: parseInt(o.interval, 10) || 2000,
        timeoutMs: parseInt(o.timeout, 10) || 10000,
      });
      emitMk(report, o.json, formatCacheDiagnosticReport(report));
    });
}
