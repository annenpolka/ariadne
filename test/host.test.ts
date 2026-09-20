import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeHost } from '../src/host/fake-host.js';
import type { FakeHostOptions, Fault } from '../src/host/fake-host.js';
import { FakeFixture } from '../src/fixture.js';
import { validateContract } from '../src/validation.js';
import { binding, grant, nodes, task } from './helpers.js';

function setup(t: TestContext, extra: Partial<FakeHostOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ariadne-host-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fixture = new FakeFixture(nodes());
  const options: FakeHostOptions = { fixture, grant: grant(), journalPath: join(dir, 'journal.jsonl'), ...extra };
  const host = new FakeHost(options);
  return { host, fixture, options };
}
async function prepare(host: FakeHost, operationId = 'op-1') {
  const session = await host.openSession(task());
  const observation = await host.capture('editable_fields');
  validateContract(observation);
  return host.prepare({ operationId, taskId: task().taskId, taskRevision: 1, sessionEpoch: session.sessionEpoch, binding: binding(observation), command: { kind: 'set_value', targetRef: 'node-email', value: task().inputs['email']! } });
}

test('commit dispatches the immutable prepared value at most once, including concurrent retries', async t => {
  const { host, fixture } = setup(t);
  const operation = await prepare(host); validateContract(operation);
  operation.command = { kind: 'set_value', targetRef: 'node-email', value: 'tampered' };
  const receipts = await Promise.all(Array.from({ length: 8 }, () => host.commit(operation.preparedId)));
  assert.equal(fixture.dispatchCount, 1);
  assert.equal(fixture.readValue('node-email'), task().inputs['email']);
  for (const receipt of receipts) { validateContract(receipt); assert.equal(receipt.status, 'attempted'); }
});
for (const mutation of ['replacement', 'disabled', 'name', 'parent', 'value', 'focus', 'modal', 'app-restart'] as const) {
  test(`preflight prevents dispatch after ${mutation}`, async t => {
    const { host, fixture } = setup(t); const operation = await prepare(host);
    if (mutation === 'replacement') fixture.mutate('node-email', { ref: 'node-replacement' });
    if (mutation === 'disabled') fixture.mutate('node-email', { enabled: { status: 'available', value: false } });
    if (mutation === 'name') fixture.mutate('node-email', { name: { status: 'available', value: '別の欄' } });
    if (mutation === 'parent') fixture.mutate('node-email', { parentRef: 'node-window' });
    if (mutation === 'value') fixture.mutate('node-email', { value: { status: 'available', value: 'human edit' } });
    if (mutation === 'focus') fixture.setFocus('another-window');
    if (mutation === 'modal') fixture.setModal('new-dialog');
    if (mutation === 'app-restart') fixture.restartApp();
    const receipt = await host.commit(operation.preparedId);
    assert.equal(receipt.status, 'not_dispatched'); assert.equal(fixture.dispatchCount, 0);
  });
}
test('read and act grants are enforced before observation and dispatch', async t => {
  const denied = setup(t, { grant: { ...grant(), read: false } });
  await assert.rejects(denied.host.openSession(task()), { code: 'scope_denied' });
  const { host, fixture } = setup(t); const operation = await prepare(host);
  host.updateGrant({ ...grant(), version: 2, act: false });
  assert.equal((await host.commit(operation.preparedId)).status, 'not_dispatched');
  assert.equal(fixture.dispatchCount, 0);
});
test('cancel invalidates prepared operations without dispatch', async t => {
  const { host, fixture } = setup(t); const operation = await prepare(host);
  await host.cancel(); assert.equal((await host.commit(operation.preparedId)).status, 'not_dispatched');
  assert.equal(fixture.dispatchCount, 0);
});
test('cancel can preempt a queued dispatch without waiting on the operation worker', async t => {
  let release!: () => void; let entered!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const { host, fixture } = setup(t, { beforeDispatch: async () => { entered(); await barrier; } });
  const operation = await prepare(host); const pending = host.commit(operation.preparedId);
  await reached; await host.cancel(); release();
  assert.equal((await pending).status, 'not_dispatched'); assert.equal(fixture.dispatchCount, 0);
});
test('expired preparation is not dispatched', async t => {
  let time = 100;
  const { host, fixture } = setup(t, { clock: () => time }); const operation = await prepare(host);
  time = operation.expiresAtMonoMs + 1;
  assert.equal((await host.commit(operation.preparedId)).status, 'expired'); assert.equal(fixture.dispatchCount, 0);
});
test('journal failure prevents the driver call', async t => {
  const { host, fixture } = setup(t); const operation = await prepare(host); host.setFault('journal_error');
  const receipt = await host.commit(operation.preparedId);
  assert.equal(receipt.status, 'not_dispatched'); assert.equal(receipt.reason, 'journal_error'); assert.equal(fixture.dispatchCount, 0);
});
for (const [fault, count] of [['after_intent', 0], ['after_dispatch', 1]] as const) {
  test(`restarting after ${fault} retains unresolved state and refuses new mutation IDs`, async t => {
    const { host, fixture, options } = setup(t); const operation = await prepare(host); host.setFault(fault as Fault);
    assert.equal((await host.commit(operation.preparedId)).status, 'outcome_unknown'); assert.equal(fixture.dispatchCount, count);
    const journal = readFileSync(options.journalPath, 'utf8'); assert.ok(journal.includes('op-1'));
    assert.ok(!journal.includes(task().inputs['email']!), 'default metadata journal must not contain input values');
    const restarted = new FakeHost(options);
    assert.equal((await restarted.status('op-1'))?.status, 'outcome_unknown');
    await assert.rejects(prepare(restarted, 'op-2'), { code: 'outcome_unknown' });
    assert.equal(fixture.dispatchCount, count);
  });
}
test('lost response reconciles to the recorded receipt without dispatching twice', async t => {
  const { host, fixture } = setup(t); const operation = await prepare(host); host.setFault('response_lost');
  await assert.rejects(host.commit(operation.preparedId));
  const receipt = await host.status(operation.operationId); assert.equal(receipt?.status, 'attempted');
  host.setFault(undefined); assert.equal((await host.commit(operation.preparedId)).status, 'attempted');
  assert.equal(fixture.dispatchCount, 1);
});
test('old prepared IDs are invalid after host restart and recorded completion is retained', async t => {
  const { host, fixture, options } = setup(t); const operation = await prepare(host);
  await host.commit(operation.preparedId);
  const restarted = new FakeHost(options); const session = await restarted.openSession(task());
  assert.notEqual(session.sessionEpoch, operation.sessionEpoch);
  assert.equal((await restarted.status(operation.operationId))?.status, 'attempted');
  await assert.rejects(restarted.commit(operation.preparedId)); assert.equal(fixture.dispatchCount, 1);
});
test('malformed existing journal is rejected instead of silently losing deduplication', async t => {
  const { options } = setup(t); writeFileSync(options.journalPath, '{broken\n');
  await assert.rejects(async () => { const host = new FakeHost(options); await host.openSession(task()); });
});
