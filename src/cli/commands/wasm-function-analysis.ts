import { Command } from 'commander';
import fs from 'fs';
import { logger } from '../../utils/logger';
import { outputJsonError } from '../../output/json';
import { WasmModule, parseWasmModule, resolveFunctionSelector } from '../../services/wasm-module';
import { analyzeCallGraph, callGraphToDot, formatCallGraph } from '../../services/wasm-call-graph';
import {
  formatFunctionReferences,
  mapFunctionReferences,
} from '../../services/wasm-function-references';
import {
  auditFunctionIntegrity,
  formatFunctionIntegrity,
} from '../../services/wasm-function-integrity';
import { analyzeSignatureUsage, formatSignatureUsage } from '../../services/wasm-signature-usage';

interface OutputOptions {
  json?: boolean;
  output?: string;
}

function emit(data: unknown, options: OutputOptions, text: string): void {
  const content = options.json ? JSON.stringify({ ok: true, data }, null, 2) : text;
  if (options.output) fs.writeFileSync(options.output, content + '\n', 'utf8');
  else process.stdout.write(content + '\n');
}

function run(options: OutputOptions, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (options.json) outputJsonError(message);
    logger.error(message);
    process.exit(1);
  }
}

function load(file: string): WasmModule {
  return parseWasmModule(fs.readFileSync(file));
}

export function registerWasmFunctionAnalysisCommands(program: Command): void {
  program
    .command('wasm-call-graph <wasmFile>')
    .description('Offline static function call graph and reachability analysis for a WASM module')
    .option(
      '--function <indexOrName>',
      'Analyze reachability from a single function (index or name)',
    )
    .option('--dot', 'Output the graph in Graphviz DOT format')
    .option('--json', 'Output nodes, edges and reachability findings as JSON')
    .option('-o, --output <file>', 'Write output to a file')
    .action((file: string, options: OutputOptions & { function?: string; dot?: boolean }) =>
      run(options, () => {
        const mod = load(file);
        const root = options.function ? resolveFunctionSelector(mod, options.function) : undefined;
        const result = analyzeCallGraph(mod, root);
        const text = options.dot ? callGraphToDot(mod, result) : formatCallGraph(mod, result);
        emit(result, options, text);
      }),
    );

  program
    .command('wasm-function-refs <wasmFile>')
    .description('Map WASM call sites and function-reference instructions to their targets')
    .option('--target <indexOrName>', 'Only references to this function')
    .option('--caller <indexOrName>', 'Only references inside this function')
    .option('--json', 'Output JSON')
    .option('-o, --output <file>', 'Write output to a file')
    .action((file: string, options: OutputOptions & { target?: string; caller?: string }) =>
      run(options, () => {
        const mod = load(file);
        const result = mapFunctionReferences(mod, {
          target: options.target ? resolveFunctionSelector(mod, options.target) : undefined,
          caller: options.caller ? resolveFunctionSelector(mod, options.caller) : undefined,
        });
        emit(result, options, formatFunctionReferences(mod, result));
      }),
    );

  program
    .command('wasm-function-integrity <wasmFile>')
    .description('Audit WASM function-index references for structural integrity')
    .option('--json', 'Output JSON')
    .option('-o, --output <file>', 'Write output to a file')
    .action((file: string, options: OutputOptions) =>
      run(options, () => {
        const result = auditFunctionIntegrity(load(file));
        emit(result, options, formatFunctionIntegrity(result));
        if (!result.valid) process.exitCode = 1;
      }),
    );

  program
    .command('wasm-signature-usage <wasmFile>')
    .description('Analyze how WASM function types (signatures) are used')
    .option('--type <index>', 'Only this type index')
    .option('--function <indexOrName>', 'Only the type used by this function')
    .option('--json', 'Output JSON')
    .option('-o, --output <file>', 'Write output to a file')
    .action((file: string, options: OutputOptions & { type?: string; function?: string }) =>
      run(options, () => {
        const mod = load(file);
        const result = analyzeSignatureUsage(mod, {
          typeIndex: options.type !== undefined ? Number(options.type) : undefined,
          functionIndex: options.function
            ? resolveFunctionSelector(mod, options.function)
            : undefined,
        });
        emit(result, options, formatSignatureUsage(result));
      }),
    );
}
