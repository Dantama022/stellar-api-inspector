import fs from 'fs';
import { Command } from 'commander';
import { inspectWasmLinking, inspectWasmNames } from '../../services/wasm-debug-metadata';
const out = (value: unknown, json: boolean, summary: string) => process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${summary}\n`);
export function registerOverlayFixtureWasmCommands(program: Command): void {
  program.command('wasm-names <wasmFile>').option('-j, --json', 'JSON output').action((file: string, options: { json?: boolean }) => { const report = inspectWasmNames(fs.readFileSync(file)); out(report, !!options.json, `${report.status}: ${report.functions.length} function name(s).`); });
  program.command('wasm-linking <wasmFile>').option('-j, --json', 'JSON output').action((file: string, options: { json?: boolean }) => { const report = inspectWasmLinking(fs.readFileSync(file)); out(report, !!options.json, `${report.status}: ${report.relocations.length} relocation section(s).`); });
}
