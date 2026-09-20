#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import exampleTask from '../examples/task.json' with { type: 'json' };
import exampleObservation from '../examples/observation.json' with { type: 'json' };
import type { Host, Node, ScopeGrant, TaskSpec } from './contracts.js';
import { validateContract } from './validation.js';
import { validateGrant } from './grants.js';
import { AriadneRuntime } from './core/runtime.js';
import { FakeFixture } from './fixture.js';
import { FakeHost } from './host/fake-host.js';
import { RpcHost } from './host/rpc-host.js';
import { ExactLabelProvider, type BindingBatch, type BindingProvider } from './providers/binding.js';
import { JevBindingProvider, type Calibration } from './providers/jev.js';
import { TextEditBodyProvider } from './providers/profile.js';
import { ReplayDriver, TraceRecorder, writePrivateJSON } from './trace.js';

function json(path: string): unknown {
  const bytes = readFileSync(path); if (bytes.length > 32 * 1024 * 1024) throw new Error('Input file exceeds 32 MiB'); return JSON.parse(bytes.toString('utf8'));
}
function taskAt(path: string): TaskSpec { const v = json(path); validateContract(v); if (v.kind !== 'task') throw new Error('Expected a Task'); return v; }
function modelCredential(keychain: boolean | undefined): string {
  if (keychain) {
    if (process.platform !== 'darwin') throw new Error('--keychain requires macOS');
    return execFileSync('/usr/bin/security', ['find-generic-password', '-s', 'typesafe-api', '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  }
  const key = process.env['TYPESAFE_API_KEY']; if (!key) throw new Error('TypeSafe credential is unavailable'); return key;
}
const help = `Ariadne: one Task in one explicitly granted window.
  ariadne demo [--state-dir DIR] [--record-replay]
  ariadne observe|preview|execute|resume --task FILE --grant FILE --state-dir DIR
    [--host fake|macos] [--pid PID --window-title TITLE --document FILE --page-url URL --host-binary FILE]
    [--provider exact|profile|jev --model MODEL --keychain --calibration FILE]
    [--record-replay] [--trace FILE]
  ariadne replay --trace FILE --grant FILE --state-dir NEW_DIR
  ariadne reevaluate --trace FILE --grant FILE --model MODEL [--keychain] [--state-dir DIR]
Raw observations are printed only by observe. --record-replay explicitly retains
Task inputs and observation values in a private local trace. Default traces contain
metadata. Resume keeps the saved cumulative budgets; it does not clear unknown effects.
Jev reads TYPESAFE_API_KEY, or --keychain reads macOS service typesafe-api in memory.
`;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    help: { type: 'boolean' }, task: { type: 'string' }, grant: { type: 'string' }, 'state-dir': { type: 'string' }, host: { type: 'string' }, pid: { type: 'string' }, 'window-title': { type: 'string' }, document: { type: 'string' }, 'page-url': { type: 'string' }, 'host-binary': { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' }, calibration: { type: 'string' }, keychain: { type: 'boolean' }, 'record-replay': { type: 'boolean' }, trace: { type: 'string' },
  } });
  if (values.help || !positionals.length) { process.stdout.write(help); return 0; }
  if (positionals.length !== 1) throw new Error('Specify exactly one command');
  const command = positionals[0]!;
  if (!['demo', 'observe', 'preview', 'execute', 'resume', 'replay', 'reevaluate'].includes(command)) throw new Error('Unknown command');
  const stateDir = resolve(values['state-dir'] ?? join('.runtime', `run-${randomUUID()}`));
  const statePath = join(stateDir, 'tasks.json');
  let task: TaskSpec; let grant: ScopeGrant;
  if (command === 'demo') {
    task = structuredClone(exampleTask) as TaskSpec; task.slots[0]!.meaning = 'メール';
    grant = { scopeRef: task.scopeRef, grantRef: 'grant-fixture', version: 1, read: true, model: false, act: true, allowedCommands: ['set_value'], appId: 'ariadne.fixture', windowRef: 'node-window', limits: task.budgets };
    writePrivateJSON(join(stateDir, 'task.json'), task); writePrivateJSON(join(stateDir, 'grant.json'), grant);
  } else {
    if (!values.grant) throw new Error('--grant is required'); const value = json(values.grant); validateGrant(value); grant = value;
    if (command === 'reevaluate') {
      if (!values.trace || !values.model) throw new Error('Reevaluation requires --trace and an explicit --model');
      if (!grant.model || !grant.read) throw new Error('Read and Model grants are required');
      const driver = new ReplayDriver(values.trace); validateContract(driver.trace.task);
      if (driver.trace.task.scopeRef !== grant.scopeRef) throw new Error('Trace and grant scopes differ');
      let index = 0;
      const provider = new JevBindingProvider({ model: values.model, apiKey: modelCredential(values.keychain), onExchange: exchange => writePrivateJSON(join(stateDir, `exchange-${++index}.json`), exchange) });
      const evaluations = [];
      for (const exchange of driver.trace.exchanges.filter(e => e.channel === 'provider' && e.method === 'bind')) {
        const input = exchange.args[0] as { task: TaskSpec; observation: Parameters<BindingProvider['bind']>[0]['observation'] };
        if (input.task.scopeRef !== grant.scopeRef || input.observation.scopeRef !== grant.scopeRef) throw new Error('Recorded binding scope differs');
        const batch = await provider.bind({ ...input, signal: AbortSignal.timeout(20_000) });
        evaluations.push({ original: exchange.result, reevaluated: batch });
      }
      const path = join(stateDir, 'reevaluation.json'); writePrivateJSON(path, { mode: 'reevaluate', model: values.model, evaluations });
      process.stdout.write(JSON.stringify({ mode: 'reevaluate', comparisons: evaluations.length, path, effects: 'No host or GUI operations were performed' }) + '\n'); return 0;
    }
    if (command === 'replay') {
      if (!values.trace) throw new Error('--trace is required'); if (existsSync(statePath)) throw new Error('Replay requires a fresh state directory');
      const driver = new ReplayDriver(values.trace); validateContract(driver.trace.task);
      const runtime = new AriadneRuntime({ host: driver.host, provider: driver.provider(), grant, statePath, environment: driver.trace.outcome?.result.assurance.environment ?? 'fixture_atomic' });
      const outcome = await runtime.run(driver.trace.task, { mode: driver.trace.outcome?.handoff?.reason === 'preview_ready' ? 'preview' : 'execute' }); driver.assertConsumed();
      if (!driver.trace.outcome || outcome.result.status !== driver.trace.outcome.result.status || JSON.stringify(outcome.result.checks) !== JSON.stringify(driver.trace.outcome.result.checks)) throw new Error('Replay result differs from the recorded result');
      process.stdout.write(JSON.stringify({ replay: 'matched', result: outcome.result }) + '\n'); return 0;
    }
    if (!values.task) throw new Error('--task is required'); task = taskAt(values.task);
  }
  validateContract(task); validateGrant(grant);
  if (command === 'resume' && !existsSync(statePath)) throw new Error('Resume requires existing --state-dir with tasks.json');
  if (!grant.read) throw new Error('Read grant is required');
  if (values.provider && !['exact', 'profile', 'jev'].includes(values.provider)) throw new Error('Unknown provider');
  const hostKind = command === 'demo' ? 'fake' : (values.host ?? 'fake');
  if (!['fake', 'macos'].includes(hostKind)) throw new Error('Unknown host');
  let host: Host; let fixture: FakeFixture | undefined;
  if (hostKind === 'fake') {
    if (grant.appId !== 'ariadne.fixture' || grant.windowRef !== 'node-window') throw new Error('Fake Host requires the fixture profile');
    const fixturePath = join(stateDir, 'fixture.json');
    fixture = new FakeFixture(existsSync(fixturePath) ? json(fixturePath) as Node[] : structuredClone(exampleObservation.nodes) as Node[]);
    host = new FakeHost({ fixture, grant, journalPath: join(stateDir, 'host.jsonl') });
  } else {
    if (!values.pid || !/^[1-9][0-9]*$/.test(values.pid) || !values['window-title']) throw new Error('macos Host requires --pid and exact --window-title');
    if (!values.grant) throw new Error('Native Host requires operator grant file');
    host = new RpcHost({ executable: resolve(values['host-binary'] ?? '.cache/swift/debug/AriadneHost'), args: ['--pid', values.pid, '--window-title', values['window-title'], '--grant', resolve(values.grant), '--journal', join(stateDir, 'host.jsonl'), ...(values.document ? ['--document', resolve(values.document)] : []), ...(values['page-url'] ? ['--page-url', values['page-url']] : [])] });
  }
  const controller = new AbortController(); const cancel = () => controller.abort(); process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    if (command === 'observe') { await host.openSession(task); process.stdout.write(JSON.stringify(await host.capture('window_summary'), null, 2) + '\n'); return 0; }
    let provider: BindingProvider;
    if (values.provider === 'jev') {
      if (!grant.model) throw new Error('Model grant is required'); if (!values.model) throw new Error('An explicit --model is required');
      const apiKey = modelCredential(values.keychain);
      provider = new JevBindingProvider({ model: values.model, apiKey, ...(values.calibration ? { calibration: json(values.calibration) as Calibration } : {}) });
    } else if (values.provider === 'profile') {
      if (hostKind !== 'macos' || grant.appId !== 'com.apple.TextEdit') throw new Error('Body profile requires the native TextEdit Host');
      provider = new TextEditBodyProvider();
    } else provider = new ExactLabelProvider();
    const recorder = new TraceRecorder(values['record-replay'] ?? false); let latestBinding: BindingBatch | undefined;
    const watched: BindingProvider = { kind: provider.kind, ...(provider.executionScope ? { executionScope: provider.executionScope } : {}), bind: async input => { latestBinding = await provider.bind(input); return latestBinding; } };
    const runtime = new AriadneRuntime({ host: recorder.host(host), provider: recorder.provider(watched), grant, statePath, environment: hostKind === 'fake' ? 'fixture_atomic' : 'external_best_effort' });
    const outcome = await runtime.run(task, { mode: command === 'preview' ? 'preview' : 'execute', signal: controller.signal });
    const tracePath = resolve(values.trace ?? join(stateDir, 'trace.json'));
    recorder.save(tracePath, task, provider, outcome);
    const preview = command === 'preview' ? { bindings: latestBinding?.bindings ?? [] } : {};
    process.stdout.write(JSON.stringify({ ...outcome, ...preview, stateDir, tracePath }, null, 2) + '\n');
    return outcome.result.status === 'verified_success' || outcome.result.status === 'completed_unverified' ? 0 : 2;
  } finally {
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
    try { await host.close(); } finally { if (fixture) writePrivateJSON(join(stateDir, 'fixture.json'), fixture.snapshot().nodes); }
  }
}
main().then(code => { process.exitCode = code; }).catch(error => { process.stderr.write(`Ariadne: ${error instanceof Error ? error.message : 'failed'}\n`); process.exitCode = 1; });
