import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Host, HostReceipt, Observation, ObservationQuery, PreparedOperation, PrepareRequest, Session, TaskSpec } from '../src/contracts.js';
import { HostError } from '../src/contracts.js';
import { AriadneRuntime } from '../src/core/runtime.js';
import { TaskLedger, taskDigest } from '../src/core/task-ledger.js';
import { FakeHost } from '../src/host/fake-host.js';
import { FakeFixture } from '../src/fixture.js';
import { ExactLabelProvider } from '../src/providers/binding.js';
import type { BindingBatch, BindingProvider } from '../src/providers/binding.js';
import { grant, loadExample, nodes, task } from './helpers.js';

const directory = (t: TestContext) => { const dir = mkdtempSync(join(tmpdir(), 'ariadne-recovery-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const emailTask = (): TaskSpec => { const input = task(); input.slots[0]!.meaning = 'メール'; return input; };

/** Minimal scripted Host so recovery/verification boundaries can be forced without touching src/host. */
class TestHost implements Host {
  observation = loadExample<Observation>('observation');
  operations: PreparedOperation[] = [];
  dispatched = 0; cancelled = 0; captures = 0; openSessions = 0;
  commitStatus: HostReceipt['status'] = 'attempted'; commitReason: HostReceipt['reason'] = 'none';
  applyValue = true; receiptSession = 'session-a'; receiptOperationId: string | undefined;
  prepareFault: HostError | undefined; dirty: 'never' | 'first' | 'always' = 'never';
  async openSession(_task: TaskSpec): Promise<Session> { this.openSessions++; return { sessionEpoch: 'session-a', controlEpoch: 0, scopeRef: 'scope-fixture', grantRef: 'grant-fixture', grantVersion: 1 }; }
  async capture(_query?: ObservationQuery): Promise<Observation> { const observation = structuredClone(this.observation); observation.observationId = `obs-${++this.captures}`; observation.sessionEpoch = 'session-a'; observation.scopeRef = 'scope-fixture'; if (this.dirty === 'always' || (this.dirty === 'first' && this.captures === 1)) observation.capture.eventSeqAfter = observation.capture.eventSeqBefore + 1; return observation; }
  async prepare(request: PrepareRequest): Promise<PreparedOperation> {
    if (this.prepareFault) throw this.prepareFault;
    const operation: PreparedOperation = { kind: 'prepared_operation', schemaVersion: '0.1', ...request, preparedId: `prepared-${this.operations.length}`, controlEpoch: 0, scopeRef: 'scope-fixture', grantRef: 'grant-fixture', grantVersion: 1, originObservationId: request.binding.observationId, guardSetRef: 'guards-test', expiresAtMonoMs: 10_000 };
    this.operations.push(structuredClone(operation)); return structuredClone(operation);
  }
  private receipt(operationId: string): HostReceipt { return { kind: 'host_receipt', schemaVersion: '0.1', operationId: this.receiptOperationId ?? operationId, sessionEpoch: this.receiptSession, eventSeq: this.dispatched, status: this.commitStatus, reason: this.commitReason }; }
  async commit(preparedId: string): Promise<HostReceipt> {
    const operation = this.operations.find(o => o.preparedId === preparedId)!;
    this.dispatched++;
    if (this.applyValue && this.commitStatus === 'attempted' && operation.command.kind === 'set_value') this.observation.nodes.find(n => n.ref === operation.command.targetRef)!.value = { status: 'available', value: operation.command.value };
    return this.receipt(operation.operationId);
  }
  async status(operationId: string): Promise<HostReceipt | null> { return this.operations.some(o => o.operationId === operationId) ? this.receipt(operationId) : null; }
  async cancel(): Promise<void> { this.cancelled++; }
  async close(): Promise<void> {}
}
const runtimeFor = (host: Host, dir: string, provider: BindingProvider = new ExactLabelProvider(), scope = grant()) => new AriadneRuntime({ host, provider, grant: scope, statePath: join(dir, 'tasks.json'), environment: 'fixture_atomic' });

test('perpetual fresh-ref churn makes no progress and dispatches nothing', async t => {
  const dir = directory(t); const fixture = new FakeFixture(nodes()); let current = 'node-email';
  class ChurnHost extends FakeHost {
    captures = 0;
    override async capture(query?: ObservationQuery) {
      if (++this.captures >= 2) { const next = `node-churn-${this.captures}`; fixture.mutate(current, { ref: next }); current = next; }
      return super.capture(query);
    }
  }
  const host = new ChurnHost({ fixture, grant: grant(), journalPath: join(dir, 'host.jsonl') });
  const outcome = await runtimeFor(host, dir).run(emailTask());
  assert.notEqual(outcome.result.status, 'verified_success');
  assert.equal(fixture.dispatchCount, 0);
});
test('observation expansion budget bounds a provider that always needs more', async t => {
  const dir = directory(t); const host = new TestHost();
  let calls = 0;
  const provider: BindingProvider = { kind: 'deterministic', async bind(request) { calls++; return { taskId: request.task.taskId, taskRevision: request.task.revision, sessionEpoch: request.observation.sessionEpoch, observationId: request.observation.observationId, bindings: [], needMoreObservation: true, notFound: false }; } };
  const input = emailTask(); input.budgets.maxObservationExpansions = 1;
  const outcome = await runtimeFor(host, dir, provider).run(input);
  assert.equal(outcome.result.status, 'blocked'); assert.match(outcome.handoff!.reason, /expansion budget/);
  assert.equal(calls, 2); assert.equal(host.dispatched, 0);
});
test('an already-aborted signal cancels before any Host mutation', async t => {
  const dir = directory(t); const host = new TestHost(); const control = new AbortController(); control.abort();
  const outcome = await runtimeFor(host, dir).run(emailTask(), { signal: control.signal });
  assert.equal(outcome.result.status, 'cancelled'); assert.equal(host.dispatched, 0); assert.equal(host.operations.length, 0);
});
test('cancelling a never-resolving provider leaks no late mutation', async t => {
  const dir = directory(t); const host = new TestHost(); const scope = grant(); scope.model = true;
  let finish!: (batch: BindingBatch) => void;
  const provider: BindingProvider = { kind: 'semantic', executionScope: 'fixture', bind() { return new Promise<BindingBatch>(resolve => { finish = resolve; }); } };
  const control = new AbortController();
  const running = runtimeFor(host, dir, provider, scope).run(emailTask(), { signal: control.signal });
  await delay(10); control.abort();
  const outcome = await running;
  assert.equal(outcome.result.status, 'cancelled'); assert.equal(host.dispatched, 0);
  finish({ taskId: 'task-demo', taskRevision: 1, sessionEpoch: 'session-a', observationId: 'obs-1', bindings: [], needMoreObservation: false, notFound: true });
  await delay(10);
  assert.equal(outcome.result.status, 'cancelled'); assert.equal(host.dispatched, 0); assert.equal(host.operations.length, 0);
});
test('a completed dispatch with failed deterministic readback is failed, not blocked', async t => {
  const dir = directory(t); const host = new TestHost(); host.applyValue = false;
  const outcome = await runtimeFor(host, dir).run(emailTask());
  assert.equal(outcome.result.status, 'failed'); assert.equal(host.dispatched, 1); assert.equal(outcome.handoff!.remaining.maxOperations, 19);
});
test('a repeated precondition_changed is blocked, not retried forever', async t => {
  const dir = directory(t); const host = new TestHost(); host.commitStatus = 'not_dispatched'; host.commitReason = 'precondition_changed';
  const outcome = await runtimeFor(host, dir).run(emailTask());
  assert.equal(outcome.result.status, 'blocked'); assert.match(outcome.handoff!.reason, /Repeated failure fingerprint/);
});
test('an unrelated changing clock cannot reset repeated failure suppression', async t => {
  class ClockHost extends TestHost {
    prepares = 0;
    override async capture(query?: ObservationQuery) {
      const observation = await super.capture(query);
      observation.nodes.push({ ref: 'node-clock', parentRef: 'node-window', role: 'text', nativeRole: 'AXStaticText', name: { status: 'available', value: `Clock ${this.captures}` }, value: { status: 'unsupported' }, enabled: { status: 'available', value: true }, capabilities: [] });
      observation.coverage.nodeCount = observation.nodes.length;
      return observation;
    }
    override async prepare(request: PrepareRequest) { this.prepares++; return super.prepare(request); }
  }
  const host = new ClockHost(); host.prepareFault = new HostError('stale_binding', 'Precondition changed');
  const outcome = await runtimeFor(host, directory(t)).run(emailTask());
  assert.equal(outcome.result.status, 'blocked'); assert.match(outcome.handoff!.reason, /Repeated failure fingerprint/);
  assert.equal(host.prepares, 2); assert.equal(host.dispatched, 0); assert.ok(host.captures >= 2);
});
test('a receipt claiming another operation is not accepted as success', async t => {
  const dir = directory(t); const host = new TestHost(); host.receiptOperationId = 'op-someone-else';
  const outcome = await runtimeFor(host, dir).run(emailTask());
  assert.notEqual(outcome.result.status, 'verified_success');
  assert.ok(outcome.result.unresolvedOperationIds.length > 0);
});
test('a closed session produces a handoff instead of a crash', async t => {
  const dir = directory(t); const host = new TestHost();
  host.openSession = async () => { throw new HostError('closed', 'Host closed'); };
  const outcome = await runtimeFor(host, dir).run(emailTask());
  assert.equal(outcome.result.status, 'blocked'); assert.ok(outcome.handoff); assert.match(outcome.handoff!.reason, /closed/);
});
test('operation budget exhaustion blocks before any dispatch', async t => {
  const dir = directory(t); const host = new TestHost(); const scope = grant(); scope.limits.maxOperations = 0;
  const outcome = await runtimeFor(host, dir, new ExactLabelProvider(), scope).run(emailTask());
  assert.equal(outcome.result.status, 'blocked'); assert.equal(host.dispatched, 0);
});

test('duplicate persisted task entries fail closed', async t => {
  const dir = directory(t); const path = join(dir, 'tasks.json'); const input = emailTask();
  const entry = { taskId: input.taskId, revision: input.revision, digest: taskDigest(input), deadlineWallMs: Date.now() + 1000, lastWallMs: Date.now(), operations: 0, semanticRequests: 0, expansions: 0, pendingOperationIds: [] };
  writeFileSync(path, JSON.stringify([entry, { ...entry }]));
  assert.throws(() => new TaskLedger(path).open(input, input.budgets), /Duplicate/);
});
test('a malformed ledger fails closed', async t => {
  const dir = directory(t); const path = join(dir, 'tasks.json'); const input = emailTask();
  writeFileSync(path, '{not json');
  assert.throws(() => new TaskLedger(path).open(input, input.budgets), /Invalid task ledger/);
});
test('the stored task digest is stable across key order but rejects changed content', t => {
  const dir = directory(t); const path = join(dir, 'tasks.json'); const input = emailTask(); const limits = input.budgets;
  const reordered = { ...input, inputs: { ...input.inputs }, slots: input.slots.map(s => ({ ...s })) } as TaskSpec;
  const a = new TaskLedger(path); const b = new TaskLedger(path);
  a.open(input, limits); b.open(reordered, limits);
  assert.equal(a.open(input, limits).digest, b.open(reordered, limits).digest);
  const changed = structuredClone(reordered); changed.inputs['email'] = 'other@example.invalid';
  assert.throws(() => b.open(changed, limits), /new revision/);
});
test('a live lease is not stolen, a dead owner is reclaimed, and the losing run never touches the Host', async t => {
  const dir = directory(t); const statePath = join(dir, 'tasks.json'); const input = emailTask();
  const owner = new TaskLedger(statePath).acquireLease(input);
  const host = new TestHost(); const outcome = await runtimeFor(host, dir).run(input);
  assert.equal(outcome.result.status, 'blocked'); assert.equal(host.openSessions, 0);
  assert.throws(() => new TaskLedger(statePath).acquireLease(input), /live process/);
  owner.release();
  const lock = `${statePath}.run`;
  const script = `const { TaskLedger } = await import(process.argv[1]); new TaskLedger(process.argv[2]).acquireLease(JSON.parse(process.argv[3])); process.kill(process.pid, 'SIGKILL');`;
  const killed = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, new URL('../src/core/task-ledger.ts', import.meta.url).href, statePath, JSON.stringify(input)]);
  assert.equal(killed.signal, 'SIGKILL');
  const reclaimed = new TaskLedger(statePath).acquireLease(input); reclaimed.release();
  assert.ok(true);
});
test('pending operations persist before commit and fence a restart', async t => {
  const dir = directory(t); const fixture = new FakeFixture(nodes()); const scope = grant();
  const host = new FakeHost({ fixture, grant: scope, journalPath: join(dir, 'host.jsonl') }); host.setFault('after_intent');
  const input = emailTask(); const path = join(dir, 'tasks.json');
  const first = await runtimeFor(host, dir).run(input);
  assert.equal(first.result.status, 'outcome_unknown'); assert.equal(fixture.dispatchCount, 0);
  const pending = new TaskLedger(path).pendingOperations(input);
  assert.deepEqual(pending, first.result.unresolvedOperationIds);
  const nextHost = new FakeHost({ fixture, grant: scope, journalPath: join(dir, 'host.jsonl') });
  const next = await runtimeFor(nextHost, dir).run(input);
  assert.equal(next.result.status, 'outcome_unknown'); assert.equal(fixture.dispatchCount, 0);
});
test('remaining deadline and counters never reset or go negative on restart', async t => {
  const dir = directory(t); const statePath = join(dir, 'tasks.json'); const input = emailTask();
  const entry = { taskId: input.taskId, revision: input.revision, digest: taskDigest(input), deadlineWallMs: Date.now() + 50, lastWallMs: Date.now(), operations: 5, semanticRequests: 5, expansions: 5, pendingOperationIds: [] };
  writeFileSync(statePath, JSON.stringify([entry]));
  const scope = grant(); scope.limits.maxOperations = 2; scope.limits.maxSemanticRequests = 3; scope.limits.maxObservationExpansions = 1; scope.limits.deadlineMs = 50;
  const outcome = await runtimeFor(new TestHost(), dir, new ExactLabelProvider(), scope).run(input, { mode: 'preview' });
  assert.equal(outcome.handoff!.remaining.maxOperations, 0);
  assert.equal(outcome.handoff!.remaining.maxSemanticRequests, 0);
  assert.ok(outcome.handoff!.remaining.deadlineMs <= 50);
});

test('a settlement after the deadline persists and stays readable', t => {
  const dir = directory(t); const path = join(dir, 'tasks.json'); const input = emailTask();
  const base = { taskId: input.taskId, revision: input.revision, digest: taskDigest(input), deadlineWallMs: Date.now() - 1000, lastWallMs: Date.now() - 2000, operations: 1, semanticRequests: 0, expansions: 0, pendingOperationIds: ['op-late'] };
  writeFileSync(path, JSON.stringify([base]));
  new TaskLedger(path).settleOperation(input, 'op-late'); // deadline expiry blocks new spending, not reconciliation
  assert.deepEqual(new TaskLedger(path).pendingOperations(input), []);
  assert.deepEqual(new TaskLedger(path).open(input, input.budgets).pendingOperationIds, []);
});
test('duplicate pending ids and unknown entry fields fail closed', t => {
  const dir = directory(t); const path = join(dir, 'tasks.json'); const input = emailTask();
  const base = { taskId: input.taskId, revision: input.revision, digest: taskDigest(input), deadlineWallMs: Date.now() + 1000, lastWallMs: Date.now(), operations: 0, semanticRequests: 0, expansions: 0, pendingOperationIds: [] };
  writeFileSync(path, JSON.stringify([{ ...base, pendingOperationIds: ['op-a', 'op-a'] }]));
  assert.throws(() => new TaskLedger(path).open(input, input.budgets), /Duplicate pending/);
  writeFileSync(path, JSON.stringify([{ ...base, unknownField: 1 }]));
  assert.throws(() => new TaskLedger(path).open(input, input.budgets), /Invalid task ledger entry/);
});
test('an oversized deadline limit is rejected before any timer is armed', t => {
  const dir = directory(t); const input = emailTask();
  assert.throws(() => new TaskLedger(join(dir, 'tasks.json')).open(input, { ...input.budgets, deadlineMs: 0x7fffffff + 1 }), /deadline limit/);
});
test('a disappeared lease is reported as lost ownership', t => {
  const dir = directory(t); const input = emailTask(); const path = join(dir, 'tasks.json');
  const lease = new TaskLedger(path).acquireLease(input);
  rmSync(`${path}.run.sqlite`, { force: true });
  assert.throws(() => lease.release(), { code: 'ENOENT' });
});
test('a transient dirty capture is retried bounded and can still complete', async t => {
  const dir = directory(t); const host = new TestHost(); host.dirty = 'first';
  const outcome = await runtimeFor(host, dir).run(emailTask());
  assert.equal(outcome.result.status, 'verified_success'); assert.equal(host.dispatched, 1);
});
test('a persistently dirty capture is bounded, never retried forever', async t => {
  const dir = directory(t); const host = new TestHost(); host.dirty = 'always';
  const outcome = await runtimeFor(host, dir).run(emailTask());
  assert.notEqual(outcome.result.status, 'verified_success'); assert.equal(host.dispatched, 0);
});
