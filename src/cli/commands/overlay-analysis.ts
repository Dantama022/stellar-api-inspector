import fs from 'fs';
import { Command } from 'commander';
import {
  analyzeOverlayMessageSequence,
  OverlayMessageFixture,
} from '../../services/overlay-message-sequence-analysis';
import { auditOverlayMessageSizes } from '../../services/overlay-message-size-audit';
import { inspectOverlayPrivacy, RedactionCategory } from '../../services/overlay-message-privacy';
import { exportOverlayMessageSchema } from '../../services/overlay-message-schema-export';

function readFixtures(file: string): OverlayMessageFixture[] {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed) || parsed.some((entry) => !entry || typeof entry !== 'object' || typeof (entry as { type?: unknown }).type !== 'string')) {
    throw new Error('Fixture input must be a JSON array of decoded overlay messages with a type field.');
  }
  return parsed as OverlayMessageFixture[];
}

function print(value: unknown, json: boolean, summary: string): void {
  process.stdout.write(json ? `${JSON.stringify({ ok: true, data: value }, null, 2)}\n` : `${summary}\n`);
}

/** Registers offline-only commands; no peer, Core, or network connection is made. */
export function registerOverlayAnalysisCommands(program: Command): void {
  program
    .command('overlay-sequence <fixtures>')
    .description('Analyze ordered decoded overlay-message fixtures for observable exchanges')
    .option('-j, --json', 'Output the complete machine-readable report')
    .action((fixtures: string, options: { json?: boolean }) => {
      const report = analyzeOverlayMessageSequence(readFixtures(fixtures));
      print(report, !!options.json, `${report.summary} ${report.findings.length} finding(s).`);
    });

  program
    .command('overlay-size-audit <fixtures>')
    .description('Audit supplied overlay XDR byte sizes and advisory payload thresholds')
    .option('--threshold <bytes>', 'Advisory encoded-size threshold in bytes', Number)
    .option('-j, --json', 'Output the complete machine-readable report')
    .action((fixtures: string, options: { threshold?: number; json?: boolean }) => {
      const report = auditOverlayMessageSizes(readFixtures(fixtures), { advisoryThresholdBytes: options.threshold });
      const violations = report.entries.filter((entry) => entry.status === 'violation').length;
      print(report, !!options.json, `${report.entries.length} message(s) audited; ${violations} documented limit violation(s).`);
    });

  program
    .command('overlay-privacy <fixtures>')
    .description('Preview or emit a privacy-sanitized report for decoded overlay fixtures')
    .option('--categories <categories>', 'Comma-separated categories: account,transaction,authentication')
    .option('--preview', 'List fields that would be redacted without changing report values')
    .option('-j, --json', 'Output the complete machine-readable report')
    .action((fixtures: string, options: { categories?: string; preview?: boolean; json?: boolean }) => {
      const categories = options.categories
        ? options.categories.split(',').map((value) => value.trim()).filter(Boolean) as RedactionCategory[]
        : undefined;
      const report = inspectOverlayPrivacy(readFixtures(fixtures), categories, !!options.preview);
      print(report, !!options.json, `${report.inspections.length} sensitive field(s) ${report.preview ? 'would be redacted' : 'inspected for redaction'}.`);
    });

  program
    .command('overlay-schema <fixtures>')
    .description('Export a structural schema description from a decoded overlay fixture')
    .option('--type <messageType>', 'Select a message type when the fixture file has more than one')
    .option('--sdk-version <version>', 'SDK/XDR version context to include', 'unknown')
    .option('-j, --json', 'Output the machine-readable schema description')
    .action((fixtures: string, options: { type?: string; sdkVersion: string; json?: boolean }) => {
      const messages = readFixtures(fixtures);
      const message = options.type ? messages.find((entry) => entry.type === options.type) : messages[0];
      if (!message) throw new Error('No matching overlay message fixture was found.');
      const report = exportOverlayMessageSchema(message, options.sdkVersion);
      print(report, !!options.json, `${report.messageType}: ${Object.keys(report.schema.fields ?? {}).length} top-level field(s).`);
    });
}
