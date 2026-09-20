/** Explicit, paid network evaluation. All source material is generated synthetic UI. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import type { Node, ObservationQuery, TaskSpec } from '../src/contracts.js';
import { FakeFixture } from '../src/fixture.js';
import { FakeHost } from '../src/host/fake-host.js';
import { AriadneRuntime } from '../src/core/runtime.js';
import { ExactLabelProvider, type BindingProvider } from '../src/providers/binding.js';
import { JevBindingProvider, type Calibration, type JevExchange } from '../src/providers/jev.js';
import { writePrivateJSON } from '../src/trace.js';
import { grant, task } from './helpers.js';

const root = resolve(process.env['ARIADNE_JEV_EVAL_DIR'] ?? `.runtime/jev-eval-${Date.now()}`);
mkdirSync(root, { recursive: true });
const model = 'jev-1.13.0';
const calibration: Calibration = { version: 'synthetic-forms-v2', model, questionSetVersion: 'binding-v2', scope: 'fixture', minProbability: 0.8, minMargin: 0.2, maxAbstention: 0.1 };
const apiKey = process.env['TYPESAFE_API_KEY'] ?? execFileSync('/usr/bin/security', ['find-generic-password', '-s', 'typesafe-api', '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const languages = [
  { regions: ['連絡先', '配送通知先'], label: 'メール', meanings: ['連絡先として使うメールアドレス', '配送の通知を受け取るメールアドレス'] },
  { regions: ['Contact details', 'Shipping notifications'], label: 'Email', meanings: ['Email address for contacting the customer', 'Email address for delivery updates'] },
  { regions: ['ご連絡先', 'お届けのお知らせ'], label: 'E-mail', meanings: ['通常の連絡を受けるメールアドレス', '荷物の配送通知用メールアドレス'] },
];
function scene(seed: number): { task: TaskSpec; nodes: Node[]; oracle: Record<string, string> } {
  const data = languages[seed % languages.length]!;
  const ref = (i: number) => `n-${createHash('sha256').update(`${seed}:${i}`).digest('hex').slice(0, 12)}`;
  const base = task(); base.taskId = `task-synthetic-${seed}`; base.inputs = { a: `a-${seed}@example.invalid`, b: `b-${seed}@example.invalid` };
  base.slots = [0, 1].map(i => ({ id: `slot-${i}`, meaning: data.meanings[i]!, inputRef: i ? 'b' : 'a', regionHint: data.regions[i]! }));
  if (seed % 6 < 2) for (const slot of base.slots) slot.meaning = data.label;
  base.requiredChecks = base.slots.map(s => ({ id: `check-${s.id}`, kind: 'value_equals_input', slotId: s.id, inputRef: s.inputRef, comparison: 'exact' }));
  const nodes: Node[] = [{ ref: 'node-window', parentRef: null, role: 'window', nativeRole: 'AXWindow', name: { status: 'available', value: 'Synthetic form' }, value: { status: 'unsupported' }, enabled: { status: 'available', value: true }, capabilities: [] }];
  const oracle: Record<string, string> = {};
  for (const i of seed % 2 ? [1, 0] : [0, 1]) {
    nodes.push({ ref: ref(i * 2), parentRef: 'node-window', role: 'group', nativeRole: 'AXGroup', name: { status: 'available', value: data.regions[i]! }, value: { status: 'unsupported' }, enabled: { status: 'available', value: true }, capabilities: [] });
    const target = ref(i * 2 + 1); oracle[`slot-${i}`] = target;
    nodes.push({ ref: target, parentRef: ref(i * 2), role: 'text_field', nativeRole: 'AXTextField', name: { status: 'available', value: data.label }, value: { status: 'available', value: '' }, enabled: { status: 'available', value: true }, capabilities: ['set_value'] });
  }
  return { task: base, nodes, oracle };
}
const calibrationSeeds = [100, 101, 102, 103, 104, 105];
const heldoutSeeds = [210, 211, 212, 213, 214, 215, 216];
writePrivateJSON(join(root, 'protocol.json'), { datasetVersion: 2, model, questionSetVersion: 'binding-v2', calibrationSeeds, heldoutSeeds, calibration, policies: ['exact', 'each_step', 'batch'], partialFirstSeed: 216, correction: 'Version 1 used only odd prime seeds, missing reversed order and Japanese variant 0. Preserved that pilot report; version 2 exercises both orders, all three labels, exact and semantic requests, and partial first observation.', caveat: 'Small synthetic fixture evaluation; no confidence guarantee or authorization for general real applications.' });
let requests = 0; const training = [];
for (const seed of calibrationSeeds) {
  const s = scene(seed); const scope = grant(); scope.model = true; const dir = join(root, `calibration-${seed}`); mkdirSync(dir);
  const host = new FakeHost({ fixture: new FakeFixture(s.nodes), grant: scope, journalPath: join(dir, 'host.jsonl') });
  await host.openSession(s.task); const observation = await host.capture();
  let evidence: JevExchange | undefined;
  const provider = new JevBindingProvider({ model, apiKey, calibration, onExchange: e => { evidence = e; requests++; writePrivateJSON(join(dir, 'exchange.json'), e); } });
  const batch = await provider.bind({ task: s.task, observation, signal: AbortSignal.timeout(20_000) });
  const wrong = batch.bindings.filter(b => s.oracle[b.slotId] !== b.targetRef).length;
  const accepted = batch.bindings.length; training.push({ seed, accepted, wrong, elapsedMs: evidence?.elapsedMs });
  await host.close();
}
writePrivateJSON(join(root, 'calibration-results.json'), training);
assert.equal(training.reduce((sum, row) => sum + row.wrong, 0), 0, 'No accepted wrong target is allowed in this small calibration set');
assert.ok(training.reduce((sum, row) => sum + row.accepted, 0) >= 8, 'Gate must accept enough calibration slots to proceed');
writePrivateJSON(join(root, 'calibration.json'), calibration);
const rows: Record<string, unknown>[] = [];
for (const seed of heldoutSeeds) for (const policy of ['exact', 'each_step', 'batch'] as const) {
  const s = scene(seed); const dir = join(root, `${seed}-${policy}`); mkdirSync(dir);
  const scope = grant(); scope.model = true;
  const fixture = new FakeFixture(s.nodes);
  class WindowingHost extends FakeHost {
    private captures = 0;
    override async capture(query?: ObservationQuery) {
      const observation = await super.capture(query);
      if (seed === 216 && ++this.captures === 1) {
        const omitted = s.oracle['slot-1']!; const group = observation.nodes.find(n => n.ref === omitted)!.parentRef;
        observation.nodes = observation.nodes.filter(n => n.ref !== omitted && n.ref !== group);
        observation.coverage = { ...observation.coverage, status: 'partial', omittedReasons: ['budget'], nodeCount: observation.nodes.length };
      }
      return observation;
    }
  }
  const host = new WindowingHost({ fixture, grant: scope, journalPath: join(dir, 'host.jsonl') });
  let semanticRequests = 0; let semanticMs = 0;
  const provider: BindingProvider = policy === 'exact' ? new ExactLabelProvider() : new JevBindingProvider({ model, apiKey, calibration, onExchange: e => { semanticRequests++; requests++; semanticMs += e.elapsedMs; writePrivateJSON(join(dir, `exchange-${semanticRequests}.json`), e); } });
  const started = performance.now();
  const outcome = await new AriadneRuntime({ host, provider, grant: scope, statePath: join(dir, 'state.json'), environment: 'fixture_atomic', bindingMode: policy === 'each_step' ? 'each_step' : 'batch' }).run(s.task);
  const elapsedMs = Math.round(performance.now() - started);
  const oracleSuccess = s.task.slots.every(slot => fixture.readValue(s.oracle[slot.id]!) === s.task.inputs[slot.inputRef]);
  const wrongTarget = fixture.operations.some(command => !s.task.slots.some(slot => s.oracle[slot.id] === command.targetRef && command.kind === 'set_value' && command.value === s.task.inputs[slot.inputRef]));
  const falseSuccess = outcome.result.status === 'verified_success' && !oracleSuccess;
  const row = { seed, policy, status: outcome.result.status, oracleSuccess, wrongTarget, falseSuccess, semanticRequests, semanticMs, elapsedMs, dispatches: fixture.dispatchCount };
  rows.push(row); writePrivateJSON(join(dir, 'outcome.json'), outcome); writePrivateJSON(join(root, 'results.json'), { root, model, requests, rows });
  await host.close();
  assert.ok(!falseSuccess && !wrongTarget, JSON.stringify(row));
}
process.stdout.write(JSON.stringify({ root, model, requests, rows }) + '\n');
