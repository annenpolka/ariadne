import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadProjection, resolveLiteralSpan, runReadTask } from '../src/read-task.js';
import { validateContract } from '../src/validation.js';
import type { LiteralSpan, ReadObservation, ReadSession, ReadSessionSpec, ReadTaskResult, ReadTaskSpec } from '../src/contracts.js';
import { defaultReadLimits } from '../src/browser-policy.js';
import { loadExample } from './helpers.js';

function fixture() {
  const task = loadExample<ReadTaskSpec>('read-task'), observation = loadExample<ReadObservation>('read-observation');
  return { task, observation };
}
function duplicate() {
  const f = fixture();
  f.observation.nodes.push({ ...structuredClone(f.observation.nodes[1]!), ref: 'other-text' });
  f.observation.coverage.nodeCount++;
  return f;
}
test('generated synthetic result is an independent golden oracle, including scalar spans and digests', () => {
  const { task, observation } = fixture();
  const context = new ReadProjection(task, observation), expected = loadExample<ReadTaskResult>('read-task-result');
  assert.deepEqual(context.project(), expected); context.verify(expected);
});
test('Unicode scalar quotes preserve emoji, combining marks and empty strings without normalization', () => {
  const { task, observation } = fixture();
  const span: LiteralSpan = { observationId: observation.observationId, nodeRef: 'node-text', attribute: 'value', start: 2, end: 3, unit: 'unicode_scalar' };
  assert.equal(resolveLiteralSpan(observation, span), '🧵');
  assert.equal(resolveLiteralSpan(observation, { ...span, start: 3, end: 5 }), 'e\u0301');
  for (const bounds of [[-1, 1], [4, 3], [0, 6], [0.5, 2], [0, Infinity]]) assert.throws(() => resolveLiteralSpan(observation, { ...span, start: bounds[0]!, end: bounds[1]! }));
  task.attributes = ['name', 'value'];
  const result = new ReadProjection(task, observation).project();
  assert.deepEqual(result.records[0]!.attributes[0], { attribute: 'name', status: 'available', text: '', evidence: { ...span, attribute: 'name', start: 0, end: 0 } });
  observation.nodes[1]!.value = { status: 'available', value: '\ud800' };
  assert.throws(() => new ReadProjection(task, observation).project(), /Unicode/);
});
test('duplicate strings are separate node records; frozen originals survive caller mutation', () => {
  const { task, observation } = duplicate();
  const context = new ReadProjection(task, observation), before = context.project();
  assert.deepEqual(before.records.map(r => r.nodeRef), ['node-text', 'other-text']);
  task.nativeRoles = ['AXButton']; observation.nodes[1]!.value = { status: 'available', value: 'Changed' };
  assert.deepEqual(context.project(), before); context.verify(before);
});
test('retain unsupported/redacted/unavailable/error attributes instead of empty strings', () => {
  for (const status of ['unsupported', 'redacted', 'unavailable', 'error'] as const) {
    const { task, observation } = fixture(); observation.nodes[1]!.value = { status };
    if (status === 'redacted' || status === 'error') {
      assert.throws(() => new ReadProjection(task, observation), /hides omitted/);
      observation.coverage.status = 'partial'; observation.coverage.omittedReasons = [status];
    }
    const context = new ReadProjection(task, observation), result = context.project();
    assert.deepEqual(result.records[0]!.attributes, [{ attribute: 'value', status }]); context.verify(result);
    assert.throws(() => resolveLiteralSpan(observation, { observationId: observation.observationId, nodeRef: 'node-text', attribute: 'value', start: 0, end: 0, unit: 'unicode_scalar' }));
  }
});
for (const partial of [false, true]) test(`no-match vs unknown is bounded by observation coverage (partial=${partial})`, () => {
  const { task, observation } = fixture(); task.nativeRoles = ['AXButton'];
  if (partial) { observation.coverage.status = 'partial'; observation.coverage.omittedReasons = ['frame']; }
  const context = new ReadProjection(task, observation), result = context.project();
  assert.equal(result.status, partial ? 'unknown' : 'no_match_in_observation'); context.verify(result);
});
test('unknown role prevents unqualified projection and no-match for a role filter', () => {
  const { task, observation } = fixture(); observation.nodes[0]!.nativeRole = 'unknown';
  assert.equal(new ReadProjection(task, observation).project().status, 'partial');
  task.nativeRoles = ['AXButton']; assert.equal(new ReadProjection(task, observation).project().status, 'unknown');
  task.nativeRoles = []; assert.equal(new ReadProjection(task, observation).project().status, 'projected');
});
test('partial source remains partial even when every selected attribute is quoted', () => {
  const { task, observation } = fixture(); observation.coverage.status = 'partial'; observation.coverage.omittedReasons = ['budget'];
  const context = new ReadProjection(task, observation), result = context.project();
  assert.equal(result.status, 'partial'); assert.equal(result.outputTruncated, false); context.verify(result);
});
test('record and UTF-8 output budgets retain a whole-record prefix, including zero output', () => {
  const { task, observation } = duplicate(); task.limits.maxRecords = 1;
  let context = new ReadProjection(task, observation), result = context.project();
  assert.equal(result.records.length, 1); assert.equal(result.outputTruncated, true); assert.equal(result.status, 'partial'); context.verify(result);
  task.limits = { maxRecords: 2048, maxOutputBytes: 8192 };
  observation.nodes[2]!.value = { status: 'available', value: '日本🧵'.repeat(1000) };
  context = new ReadProjection(task, observation); result = context.project();
  assert.equal(result.records.length, 1); assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 8192); context.verify(result);
  observation.nodes[1]!.value = observation.nodes[2]!.value;
  context = new ReadProjection(task, observation); result = context.project();
  assert.equal(result.records.length, 0); assert.equal(result.status, 'partial'); context.verify(result);
});
for (const [name, mutate] of [
  ['same text from another node', (r: ReadTaskResult) => { const a = r.records[0]!.attributes[0]!; if (a.status === 'available') a.evidence.nodeRef = 'other-text'; }],
  ['same text from another attribute', (r: ReadTaskResult) => { const a = r.records[0]!.attributes[0]!; if (a.status === 'available') a.evidence.attribute = 'name'; }],
  ['forged reference', (r: ReadTaskResult) => { r.records[0]!.nodeRef = 'forged'; }],
  ['foreign observation', (r: ReadTaskResult) => { r.source.observationId = 'foreign'; }],
  ['cross document', (r: ReadTaskResult) => { r.source.document.generation++; }],
  ['task change', (r: ReadTaskResult) => { r.taskDigest = '0'.repeat(64); }],
  ['swapped records', (r: ReadTaskResult) => { r.records.reverse(); }],
  ['missing attribute', (r: ReadTaskResult) => { r.records[0]!.attributes = []; }],
  ['invented text', (r: ReadTaskResult) => { const a = r.records[0]!.attributes[0]!; if (a.status === 'available') a.text = 'ABCDE'; }],
  ['wrong field with valid quote', (r: ReadTaskResult) => { const a = r.records[0]!.attributes[0]!; a.attribute = 'name'; if (a.status === 'available') a.evidence.attribute = 'name'; }],
  ['unjustified omission', (r: ReadTaskResult) => { r.records.pop(); r.outputTruncated = true; r.status = 'partial'; }],
  ['overclaim status', (r: ReadTaskResult) => { r.status = 'no_match_in_observation'; }],
] as const) test(`independent verifier rejects ${name}`, () => {
  const { task, observation } = duplicate(); observation.nodes[1]!.name = structuredClone(observation.nodes[1]!.value);
  const context = new ReadProjection(task, observation), result = context.project(); mutate(result);
  assert.throws(() => context.verify(result));
});
test('reject source, region and task widening before projection', () => {
  for (const change of [
    (t: ReadTaskSpec) => { t.document.generation++; },
    (t: ReadTaskSpec) => { t.scopeRef = 'foreign'; },
    (t: ReadTaskSpec) => { t.rootRef = 'foreign'; },
    (t: ReadTaskSpec) => { t.nativeRoles = ['unknown']; },
    (t: ReadTaskSpec) => { t.attributes = ['name', 'name']; },
    (t: ReadTaskSpec) => { t.limits.maxRecords = 65537; },
  ]) { const { task, observation } = fixture(); change(task); assert.throws(() => new ReadProjection(task, observation)); }
  const { task } = fixture(); assert.throws(() => validateContract({ ...task, completeness: 'all_records' }));
});
test('independent region uses only its own capture; full-observation evidence does not migrate', () => {
  const { task, observation } = fixture(); const old = new ReadProjection(task, observation).project();
  task.rootRef = 'node-text'; observation.nodes = [observation.nodes[1]!]; observation.nodes[0]!.parentRef = null;
  observation.observationId = 'region-observation'; observation.coverage.rootRef = task.rootRef; observation.coverage.nodeCount = 1;
  const context = new ReadProjection(task, observation); context.verify(context.project()); assert.throws(() => context.verify(old));
});
function sessionFor(task: ReadTaskSpec): { spec: ReadSessionSpec; session: ReadSession } {
  return { spec: { kind: 'read_session', schemaVersion: '0.1', readSessionId: task.readSessionId, scopeRef: task.scopeRef, limits: { ...defaultReadLimits } },
    session: { sessionEpoch: task.document.sessionEpoch, controlEpoch: 0, scopeRef: task.scopeRef, grantRef: 'grant-read', grantVersion: 1, document: structuredClone(task.document) } };
}
test('run fixes task before asynchronous read, makes one read and accepts no mutation/model interface', async () => {
  const { task, observation } = fixture(), { spec, session } = sessionFor(task); let calls = 0;
  const output = await runReadTask({ read: async () => { calls++; task.attributes = ['name']; return observation; } }, spec, session, task);
  assert.equal(calls, 1); assert.deepEqual(output.task.attributes, ['value']); assert.equal(output.result.records[0]!.attributes[0]!.attribute, 'value');
});
test('cancel during pending read discards its late success; pre-cancel makes zero reads', async () => {
  const { task, observation } = fixture(), { spec, session } = sessionFor(task); const control = new AbortController(); let calls = 0;
  const host = { read: async () => { calls++; control.abort(); return observation; } };
  await assert.rejects(runReadTask(host, spec, session, task, control.signal), { code: 'cancelled' });
  await assert.rejects(runReadTask(host, spec, session, task, control.signal), { code: 'cancelled' }); assert.equal(calls, 1);
});
test('mismatched read session is rejected before read, stale async document is rejected after read', async () => {
  const { task, observation } = fixture(), { spec, session } = sessionFor(task); let calls = 0;
  const host = { read: async () => { calls++; return observation; } };
  await assert.rejects(runReadTask(host, { ...spec, readSessionId: 'foreign' }, session, task), /session mismatch/); assert.equal(calls, 0);
  observation.document.generation++; await assert.rejects(runReadTask(host, spec, session, task), /document mismatch/);
});
