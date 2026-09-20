import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AriadneRuntime } from '../src/core/runtime.js';
import { TaskLedger } from '../src/core/task-ledger.js';
import { FakeHost } from '../src/host/fake-host.js';
import { FakeFixture } from '../src/fixture.js';
import { ExactLabelProvider } from '../src/providers/binding.js';
import { grant, nodes, task } from './helpers.js';
import type { HostReceipt } from '../src/contracts.js';

test('foreign status receipt cannot settle a pending operation on resume', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ariadne-receipt-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fixed = task(); fixed.slots[0]!.meaning = 'メール'; const statePath = join(dir, 'state.json');
  const ledger = new TaskLedger(statePath); ledger.open(fixed, fixed.budgets); ledger.beginOperation(fixed, 'op-pending', fixed.budgets);
  class ForeignStatus extends FakeHost {
    override async status(): Promise<HostReceipt> { return { kind: 'host_receipt', schemaVersion: '0.1', operationId: 'op-other', sessionEpoch: 'old-epoch', eventSeq: 0, status: 'attempted', reason: 'none' }; }
  }
  const fixture = new FakeFixture(nodes());
  const host = new ForeignStatus({ fixture, grant: grant(), journalPath: join(dir, 'host.jsonl') });
  const out = await new AriadneRuntime({ host, grant: grant(), provider: new ExactLabelProvider(), statePath, environment: 'fixture_atomic' }).run(fixed);
  assert.equal(out.result.status, 'outcome_unknown'); assert.deepEqual(out.result.unresolvedOperationIds, ['op-pending']); assert.equal(fixture.dispatchCount, 0);
});
test('failure persisting settlement cannot produce verified_success', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ariadne-settlement-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fixed = task(); fixed.slots[0]!.meaning = 'メール'; const statePath = join(dir, 'state.json');
  class BrokenSettlement extends FakeHost {
    override async commit(id: string): Promise<HostReceipt> {
      const receipt = await super.commit(id);
      renameSync(statePath, `${statePath}.saved`); mkdirSync(statePath);
      return receipt;
    }
  }
  const fixture = new FakeFixture(nodes());
  const host = new BrokenSettlement({ fixture, grant: grant(), journalPath: join(dir, 'host.jsonl') });
  const out = await new AriadneRuntime({ host, grant: grant(), provider: new ExactLabelProvider(), statePath, environment: 'fixture_atomic' }).run(fixed);
  assert.notEqual(out.result.status, 'verified_success'); assert.ok(out.handoff); assert.equal(fixture.dispatchCount, 1);
});
test('already-aborted losing runtime cannot cancel the lease owner host', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ariadne-cancel-'));
  const statePath = join(dir, 'state.json'); const fixed = task(); const lease = new TaskLedger(statePath).acquireLease(fixed);
  t.after(() => { try { lease.release(); } finally { rmSync(dir, { recursive: true, force: true }); } });
  let cancels = 0;
  class CountingHost extends FakeHost { override async cancel() { cancels++; await super.cancel(); } }
  const host = new CountingHost({ fixture: new FakeFixture(nodes()), grant: grant(), journalPath: join(dir, 'host.jsonl') });
  const controller = new AbortController(); controller.abort();
  await new AriadneRuntime({ host, grant: grant(), provider: new ExactLabelProvider(), statePath, environment: 'fixture_atomic' }).run(fixed, { signal: controller.signal });
  assert.equal(cancels, 0);
});
