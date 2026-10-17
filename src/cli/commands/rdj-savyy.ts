import { Command } from 'commander';
import ora from 'ora';
import fs from 'fs';
import chalk from 'chalk';
import { logger } from '../../utils/logger';
import { outputJsonError } from '../../output/json';
import { compareSimulationInputs } from '../../services/soroban-simulation-diff';
import { formatSorobanSimulationDiff } from '../../output/soroban-simulation-diff';

const noopSpinner = {
  succeed: (_msg?: string) => undefined,
  fail: (_msg?: string) => undefined,
  start: () => noopSpinner,
};

function makeSpinner(text: string, jsonMode: boolean) {
  return jsonMode ? noopSpinner : ora(text);
}

function writeResult(
  data: unknown,
  options: { json?: boolean; output?: string },
  prettyText: string,
): void {
  if (options.json) {
    const jsonStr = JSON.stringify({ ok: true, data }, null, 2);
    if (options.output) {
      fs.writeFileSync(options.output, jsonStr, 'utf8');
      process.stderr.write(chalk.green(`[SUCCESS] Output saved to ${options.output}\n`));
    } else {
      process.stdout.write(jsonStr + '\n');
    }
    return;
  }
  if (options.output) {
    // eslint-disable-next-line no-control-regex
    const clean = prettyText.replace(/\u001b\[[0-9;]*m/g, '');
    fs.writeFileSync(options.output, clean, 'utf8');
    process.stderr.write(chalk.green(`[SUCCESS] Output saved to ${options.output}\n`));
  } else {
    process.stdout.write(prettyText + '\n');
  }
}

function fail(
  spinner: { fail: (m?: string) => unknown },
  message: string,
  options: { json?: boolean },
): never {
  spinner.fail(message);
  if (options.json) outputJsonError(message);
  logger.error(message);
  process.exit(1);
}

export function registerRdjSavyyCommands(program: Command): void {
  // -------------------------------------------------------------------------
  // Soroban Contract Invocation Simulation Diff
  // -------------------------------------------------------------------------
  program
    .command('soroban-simulation-diff <baselineFile> <comparisonFile>')
    .description('Compare two saved Soroban simulation results (read-only, no submission)')
    .option('-j, --json', 'Output raw JSON')
    .option('-o, --output <path>', 'Save output to file')
    .action(
      (baselineFile: string, comparisonFile: string, options: { json?: boolean; output?: string }) => {
        if (options.json) logger.setJsonMode(true);
        const spinner = makeSpinner('Comparing simulations...', !!options.json).start();
        let a: string;
        let b: string;
        try {
          a = fs.readFileSync(baselineFile, 'utf8');
          b = fs.readFileSync(comparisonFile, 'utf8');
        } catch (err: unknown) {
          return fail(spinner, `Unable to read simulation file: ${err instanceof Error ? err.message : String(err)}`, options);
        }
        const report = compareSimulationInputs(a, b, baselineFile, comparisonFile);
        if (!('differences' in report)) return fail(spinner, report.error, options);
        spinner.succeed('Simulation comparison complete.');
        writeResult(report, options, formatSorobanSimulationDiff(report));
      },
    );
}
