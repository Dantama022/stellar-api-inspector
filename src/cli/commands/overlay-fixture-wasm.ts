import fs from 'fs';
import { Command } from 'commander';
import { inspectWasmLinking, inspectWasmNames } from '../../services/wasm-debug-metadata';
const out = (value: unknown, json: boolean, summary: string) => process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${summary}\n`);
export function registerOverlayFixtureWasmCommands(program: Command): void {
  program.command('wasm-names <wasmFile>').option('-j, --json', 'JSON output').action((file: string, options: { json?: boolean }) => { const report = inspectWasmNames(fs.readFileSync(file)); out(report, !!options.json, `${report.status}: ${report.functions.length} function name(s).`); });
  program.command('wasm-linking <wasmFile>').option('-j, --json', 'JSON output').action((file: string, options: { json?: boolean }) => { const report = inspectWasmLinking(fs.readFileSync(file)); out(report, !!options.json, `${report.status}: ${report.relocations.length} relocation section(s).`); });
import { defaultOverlayFixtures, generateOverlayFixture } from '../../services/overlay-fixtures';
import { generateOverlayFuzzCases, runOverlayFuzz } from '../../services/overlay-fuzz';
import { inspectWasmLinking, inspectWasmNames } from '../../services/wasm-debug-metadata';
const out = (value: unknown, json: boolean, summary: string) => process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${summary}\n`);
export function registerOverlayFixtureWasmCommands(program: Command): void {
  program.command('overlay-fixture <type>').option('--fields <json>', 'JSON object fields', '{}').option('--seed <seed>', 'Deterministic seed', 'stellar-api-inspector').option('--xdr-out <path>', 'Write base64 fixture').option('-j, --json', 'JSON output').action((type: string, options: { fields: string; seed: string; xdrOut?: string; json?: boolean }) => { const fixture = generateOverlayFixture(type, JSON.parse(options.fields), options.seed); if (options.xdrOut) fs.writeFileSync(options.xdrOut, fixture.xdr, 'utf8'); out(fixture, !!options.json, `Generated synthetic ${fixture.type} fixture (${fixture.sha256}).`); });
  program.command('overlay-fuzz <xdrFile>').option('--iterations <count>', 'Bounded case count', Number, 16).option('--seed <seed>', 'Deterministic seed', 'fuzz').option('-j, --json', 'JSON output').action((file: string, options: { iterations: number; seed: string; json?: boolean }) => { const cases = generateOverlayFuzzCases(fs.readFileSync(file, 'utf8').trim(), options.iterations, options.seed); const report = runOverlayFuzz(cases, (xdr) => Buffer.from(xdr, 'base64')); out(report, !!options.json, `Executed ${report.executed} offline fuzz case(s); ${report.failures.length} decoder failure(s).`); });
  program.command('wasm-names <wasmFile>').option('-j, --json', 'JSON output').action((file: string, options: { json?: boolean }) => { const report = inspectWasmNames(fs.readFileSync(file)); out(report, !!options.json, `${report.status}: ${report.functions.length} function name(s).`); });
  program.command('wasm-linking <wasmFile>').option('-j, --json', 'JSON output').action((file: string, options: { json?: boolean }) => { const report = inspectWasmLinking(fs.readFileSync(file)); out(report, !!options.json, `${report.status}: ${report.relocations.length} relocation section(s).`); });
  void defaultOverlayFixtures;
}
