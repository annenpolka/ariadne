import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Host, HostReceipt, Observation, PreparedOperation, PrepareRequest, Session, TaskSpec } from '../src/contracts.js';
import { AriadneRuntime } from '../src/core/runtime.js';
import { ExactLabelProvider } from '../src/providers/binding.js';
import type { BindingProvider } from '../src/providers/binding.js';
import { loadExample, grant, task } from './helpers.js';

/** This isolates Core sequencing, not native guards or durable dispatch. Host tests cover those. */
class ScriptedHost implements Host {
  observation = loadExample<Observation>('observation');
  operations: PreparedOperation[] = []; dispatched = 0; cancelled = 0; captures = 0;
  loseResponse = false; unknown = false;
  async openSession(_task: TaskSpec): Promise<Session> { return { sessionEpoch: 'session-a', controlEpoch: 0, scopeRef: 'scope-fixture', grantRef: 'grant-fixture', grantVersion: 1 }; }
  async capture(): Promise<Observation> {
    const observation = structuredClone(this.observation); observation.observationId = `obs-${++this.captures}`; return observation;
  }
  async prepare(request: PrepareRequest): Promise<PreparedOperation> {
    const op: PreparedOperation = { kind: 'prepared_operation', schemaVersion: '0.1', ...request, preparedId: `prepared-${this.operations.length}`, controlEpoch: 0, scopeRef: 'scope-fixture', grantRef: 'grant-fixture', grantVersion: 1, originObservationId: request.binding.observationId, guardSetRef: 'guards-test', expiresAtMonoMs: 10_000 };
    this.operations.push(structuredClone(op)); return structuredClone(op);
  }
  async commit(preparedId: string): Promise<HostReceipt> {
    const operation = this.operations.find(o => o.preparedId === preparedId)!;
    this.dispatched++;
    if (operation.command.kind === 'set_value') this.observation.nodes.find(n => n.ref === operation.command.targetRef)!.value = { status: 'available', value: operation.command.value };
    if (this.loseResponse) throw new Error('Response lost');
    return this.receipt(operation.operationId);
  }
  private receipt(operationId: string): HostReceipt { return { kind: 'host_receipt', schemaVersion: '0.1', operationId, sessionEpoch: 'session-a', eventSeq: this.dispatched, status: this.unknown ? 'outcome_unknown' : 'attempted', reason: this.unknown ? 'host_lost' : 'none' }; }
  async status(operationId: string): Promise<HostReceipt | null> { return this.receipt(operationId); }
  async cancel(): Promise<void> { this.cancelled++; }
  async close(): Promise<void> {}
}
function setup(t: TestContext, provider: BindingProvider = new ExactLabelProvider()) {
  const dir = mkdtempSync(join(tmpdir(), 'ariadne-core-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = new ScriptedHost(); const scope = grant(); scope.model = true;
  const runtime = new AriadneRuntime({ host, provider, grant: scope, statePath: join(dir, 'tasks.json'), environment: 'fixture_atomic' });
  const input = task(); input.slots[0]!.meaning = 'メール';
  return { runtime, host, input, scope, dir };
}
test('Core fills the region-matched field and verifies all fixed checks', async t => {
  const { runtime, host, input } = setup(t);
  const outcome = await runtime.run(input);
  assert.equal(outcome.result.status, 'verified_success'); assert.equal(host.dispatched, 1);
  assert.equal(outcome.result.checks.length, input.requiredChecks.length); assert.equal(outcome.handoff, null);
  assert.ok(outcome.result.checks.every(c => c.evidence.some(e => e.field === 'value') && c.evidence.some(e => e.field === 'parentRef')));
});
test('already-correct input is checked without dispatch', async t => {
  const { runtime, host, input } = setup(t); host.observation.nodes[2]!.value = { status: 'available', value: input.inputs['email']! };
  assert.equal((await runtime.run(input)).result.status, 'verified_success'); assert.equal(host.dispatched, 0);
});
test('unavailable value does not become an empty string or permit overwrite', async t => {
  const { runtime, host, input } = setup(t); host.observation.nodes[2]!.value = { status: 'unavailable' };
  assert.equal((await runtime.run(input)).result.status, 'blocked'); assert.equal(host.dispatched, 0);
});
test('preview produces no mutation and cannot report verified success', async t => {
  const { runtime, host, input } = setup(t);
  assert.equal((await runtime.run(input, { mode: 'preview' })).result.status, 'completed_unverified');
  assert.equal(host.dispatched, 0); assert.equal(host.operations.length, 0);
});
test('late model answer with wrong task revision is rejected', async t => {
  const base = new ExactLabelProvider();
  const provider: BindingProvider = { kind: 'semantic', executionScope: 'fixture', async bind(request) { const batch = await base.bind(request); return { ...batch, taskRevision: 999 }; } };
  const { runtime, host, input } = setup(t, provider);
  assert.equal((await runtime.run(input)).result.status, 'blocked'); assert.equal(host.dispatched, 0);
});
test('no ModelGrant means no provider invocation', async t => {
  let calls = 0;
  const provider: BindingProvider = { kind: 'semantic', executionScope: 'fixture', bind() { calls++; throw new Error('must not call'); } };
  const { runtime, host, input, scope } = setup(t, provider); scope.model = false;
  assert.equal((await runtime.run(input)).result.status, 'blocked'); assert.equal(calls, 0); assert.equal(host.dispatched, 0);
});
test('cancel terminates an uncooperative provider and ignores its late completion', async t => {
  let started!: () => void; let finish!: (value: Awaited<ReturnType<BindingProvider['bind']>>) => void;
  const pending = new Promise<void>(resolve => { started = resolve; });
  const provider: BindingProvider = { kind: 'semantic', executionScope: 'fixture', bind() { started(); return new Promise(resolve => { finish = resolve; }); } };
  const { runtime, host, input } = setup(t, provider); const control = new AbortController();
  const running = runtime.run(input, { signal: control.signal }); await pending; control.abort();
  const outcome = await running; assert.equal(outcome.result.status, 'cancelled'); assert.equal(host.dispatched, 0);
  finish({ taskId: input.taskId, taskRevision: 1, sessionEpoch: 'session-a', observationId: 'obs-1', bindings: [], needMoreObservation: false, notFound: true });
  await Promise.resolve(); assert.equal(outcome.result.status, 'cancelled'); assert.equal(host.dispatched, 0);
});
test('deadline bounds a never-resolving provider', async t => {
  const provider: BindingProvider = { kind: 'semantic', executionScope: 'fixture', bind: () => new Promise(() => {}) };
  const { runtime, host, input, scope } = setup(t, provider); scope.limits.deadlineMs = 25;
  const outcome = await runtime.run(input); assert.equal(outcome.result.status, 'blocked'); assert.match(outcome.handoff!.reason, /deadline/); assert.equal(host.dispatched, 0);
});
test('lost commit response is reconciled by status without another commit', async t => {
  const { runtime, host, input } = setup(t); host.loseResponse = true;
  assert.equal((await runtime.run(input)).result.status, 'verified_success'); assert.equal(host.dispatched, 1);
});
test('unknown commit produces an unresolved operation and cannot report success', async t => {
  const { runtime, host, input } = setup(t); host.unknown = true;
  const outcome = await runtime.run(input); assert.equal(outcome.result.status, 'outcome_unknown');
  assert.equal(outcome.result.unresolvedOperationIds.length, 1); assert.equal(host.dispatched, 1);
});
test('task input changes require a new revision even after a prior run', async t => {
  const { runtime, input } = setup(t); await runtime.run(input, { mode: 'preview' });
  input.inputs['email'] = 'changed@example.invalid';
  const outcome = await runtime.run(input); assert.equal(outcome.result.status, 'blocked'); assert.match(outcome.handoff!.reason, /revision/);
});
