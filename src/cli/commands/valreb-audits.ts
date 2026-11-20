import { Command } from 'commander';
import fs from 'fs';
import { outputJson, outputJsonError } from '../../output/json';
import { auditHorizonPagination, formatPaginationAuditReport } from '../../services/horizon-pagination-completeness-audit';

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
}
