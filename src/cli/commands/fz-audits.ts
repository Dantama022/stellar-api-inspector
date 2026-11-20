import { Command } from 'commander';
import { outputJsonError } from '../../output/json';
import { auditHorizonTls, formatFzTlsAudit } from '../../services/fz-tls-audit';

function fzFail(message: string, json?: boolean): never {
  if (json) outputJsonError(message);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

export function registerFzAuditCommands(program: Command): void {
  program
    .command('fz-tls-audit <url>')
    .description('Audit the TLS certificate and HTTPS configuration of a Horizon endpoint')
    .option('--timeout <ms>', 'Connection timeout in milliseconds', '10000')
    .option('--ca-file <path>', 'Additional PEM CA bundle to trust')
    .option('--warn-days <n>', 'Warn when certificate expires within n days', '30')
    .option('-j, --json', 'Output raw JSON')
    .action(async (url: string, o: { timeout: string; caFile?: string; warnDays: string; json?: boolean }) => {
      const timeoutMs = parseInt(o.timeout, 10);
      const warnDays = parseInt(o.warnDays, 10);
      if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) fzFail('--timeout must be a positive integer', o.json);
      if (!Number.isInteger(warnDays) || warnDays < 0) fzFail('--warn-days must be a non-negative integer', o.json);
      const r = await auditHorizonTls(url, { timeoutMs, warnDays, caFile: o.caFile });
      process.stdout.write((o.json ? JSON.stringify({ ok: true, data: r }, null, 2) : formatFzTlsAudit(r)) + '\n');
    });
}
