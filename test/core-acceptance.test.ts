import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AriadneRuntime } from '../src/core/runtime.js';
import { TaskLedger } from '../src/core/task-ledger.js';
import { FakeHost } from '../src/host/fake-host.js';
import { FakeFixture } from '../src/fixture.js';
import { ExactLabelProvider } from '../src/providers/binding.js';
import type { ObservationQuery } from '../src/contracts.js';
import { grant, nodes, task } from './helpers.js';

const directory = (t: TestContext) => { const dir = mkdtempSync(join(tmpdir(), 'ariadne-core-accept-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };

test('real Core and fake Host complete the fixed form contract', async t => {
  const dir = directory(t); const fixture = new FakeFixture(nodes());
  const host = new FakeHost({ fixture, grant: grant(), journalPath: join(dir, 'host.jsonl') });
  const runtime = new AriadneRuntime({ host, provider: new ExactLabelProvider(), grant: grant(), statePath: join(dir, 'tasks.json'), environment: 'fixture_atomic' });
  const input = task(); input.slots[0]!.meaning = 'メール';
  const output = await runtime.run(input); assert.equal(output.result.status, 'verified_success', output.handoff?.reason);
  assert.equal(fixture.readValue('node-email'), input.inputs['email']); assert.equal(fixture.dispatchCount, 1);
});
test('a changed element is rebound under the same fixed Task before dispatch', async t => {
  const dir = directory(t); const fixture = new FakeFixture(nodes());
  class ReplacingHost extends FakeHost {
    captures = 0;
    override async capture(query?: ObservationQuery) {
      if (++this.captures === 2) fixture.mutate('node-email', { ref: 'node-new' });
      return super.capture(query);
    }
  }
  const host = new ReplacingHost({ fixture, grant: grant(), journalPath: join(dir, 'host.jsonl') });
  const runtime = new AriadneRuntime({ host, provider: new ExactLabelProvider(), grant: grant(), statePath: join(dir, 'tasks.json'), environment: 'fixture_atomic' });
  const input = task(); input.slots[0]!.meaning = 'メール';
  const output = await runtime.run(input); assert.equal(output.result.status, 'verified_success', output.handoff?.reason);
  assert.equal(fixture.dispatchCount, 1); assert.equal(fixture.operations[0]?.targetRef, 'node-new');
  assert.equal(output.result.taskRevision, input.revision); assert.deepEqual(output.result.requiredCheckIds, input.requiredChecks.map(c => c.id));
});
test('two ledger instances cannot overwrite cumulative operation usage', t => {
  const path = join(directory(t), 'tasks.json'); const input = task(); const limits = input.budgets;
  const first = new TaskLedger(path); const second = new TaskLedger(path);
  first.open(input, limits); second.open(input, limits);
  first.spend(input, 'operations', limits); second.spend(input, 'operations', limits);
  assert.equal(new TaskLedger(path).open(input, limits).operations, 2);
});
test('remaining deadline on resume reflects the original persisted deadline', async t => {
  const dir = directory(t); const scope = grant(); scope.limits.deadlineMs = 180;
  const fixture = new FakeFixture(nodes()); const host = new FakeHost({ fixture, grant: scope, journalPath: join(dir, 'host.jsonl') });
  const runtime = new AriadneRuntime({ host, provider: new ExactLabelProvider(), grant: scope, statePath: join(dir, 'tasks.json'), environment: 'fixture_atomic' });
  const input = task(); input.slots[0]!.meaning = 'メール';
  await runtime.run(input, { mode: 'preview' }); await delay(80);
  const output = await runtime.run(input, { mode: 'preview' });
  assert.ok(output.handoff!.remaining.deadlineMs < 100, JSON.stringify(output.handoff));
});
test('unknown outcome remains observable after restart but blocks changes with new IDs', async t => {
  const dir = directory(t); const fixture = new FakeFixture(nodes()); const scope = grant();
  const host = new FakeHost({ fixture, grant: scope, journalPath: join(dir, 'host.jsonl') }); host.setFault('after_dispatch');
  const input = task(); input.slots[0]!.meaning = 'メール';
  const first = await new AriadneRuntime({ host, provider: new ExactLabelProvider(), grant: scope, statePath: join(dir, 'tasks.json'), environment: 'fixture_atomic' }).run(input);
  assert.equal(first.result.status, 'outcome_unknown');
  const nextHost = new FakeHost({ fixture, grant: scope, journalPath: join(dir, 'host.jsonl') });
  await nextHost.openSession(input); assert.ok((await nextHost.capture()).nodes.length > 0);
  assert.equal((await nextHost.status(first.result.unresolvedOperationIds[0]!))?.status, 'outcome_unknown');
  // Matching current values cannot erase unresolved effects or turn resume into verified_success.
  const next = await new AriadneRuntime({ host: nextHost, provider: new ExactLabelProvider(), grant: scope, statePath: join(dir, 'tasks.json'), environment: 'fixture_atomic' }).run(input);
  assert.equal(next.result.status, 'outcome_unknown'); assert.equal(fixture.dispatchCount, 1);
});
