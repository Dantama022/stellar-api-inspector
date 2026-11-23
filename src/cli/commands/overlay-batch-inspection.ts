import fs from 'fs';
import { Command } from 'commander';
import { inspectOverlayBatch } from '../../services/overlay-inspection';

/** Register an offline batch command; fixtures are read locally and never transmitted. */
export function registerOverlayBatchInspectionCommands(program: Command): void {
  program
    .command('overlay-batch <file>')
    .description('Inspect a local JSON array of overlay XDR fixtures and optionally compare a second set')
    .option('--compare <file>', 'Second fixture collection for explicit-ID comparison')
    .option('-j, --json', 'Output the complete machine-readable report')
    .action((file: string, options: { compare?: string; json?: boolean }) => {
      const messages = JSON.parse(fs.readFileSync(file, 'utf8'));
      const comparison = options.compare ? JSON.parse(fs.readFileSync(options.compare, 'utf8')) : undefined;
      const report = inspectOverlayBatch(messages, comparison);
      process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : `${report.results.length} message(s) inspected; ${Object.keys(report.counts).length} outcome type(s).\n`);
    });
}
