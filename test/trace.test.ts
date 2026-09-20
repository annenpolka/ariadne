import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TraceRecorder, ReplayDriver } from '../src/trace.js';
import { FakeHost } from '../src/host/fake-host.js';
import { FakeFixture } from '../src/fixture.js';
import { AriadneRuntime } from '../src/core/runtime.js';
import { ExactLabelProvider } from '../src/providers/binding.js';
import { grant, nodes, task } from './helpers.js';

test('replay follows recorded bindings and observations without a live host or provider', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ariadne-replay-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fixed = task(); fixed.slots[0]!.meaning = 'メール';
  const fixture = new FakeFixture(nodes()); const host = new FakeHost({ fixture, grant: grant(), journalPath: join(dir, 'journal') });
  const provider = new ExactLabelProvider(); const recorder = new TraceRecorder(true);
  const outcome = await new AriadneRuntime({ host: recorder.host(host), provider: recorder.provider(provider), grant: grant(), statePath: join(dir, 'state'), environment: 'fixture_atomic' }).run(fixed);
  assert.equal(outcome.result.status, 'verified_success'); assert.equal(fixture.dispatchCount, 1);
  const path = join(dir, 'trace.json'); recorder.save(path, fixed, provider, outcome); await host.close();
  const driver = new ReplayDriver(path);
  const replay = await new AriadneRuntime({ host: driver.host, provider: driver.provider(), grant: grant(), statePath: join(dir, 'replay-state'), environment: 'fixture_atomic' }).run(fixed);
  driver.assertConsumed(); assert.deepEqual(replay.result, outcome.result); assert.equal(fixture.dispatchCount, 1);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});
test('metadata trace omits supplied input and observed value and refuses exact replay', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ariadne-metadata-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fixed = task(); fixed.inputs.email = 'synthetic-input-do-not-retain'; fixed.slots[0]!.meaning = 'メール';
  const fixture = new FakeFixture(nodes()); fixture.mutate('node-email', { value: { status: 'available', value: 'synthetic-old-screen-value' } });
  const host = new FakeHost({ fixture, grant: grant(), journalPath: join(dir, 'journal') });
  const provider = new ExactLabelProvider(); const recorder = new TraceRecorder(false);
  const outcome = await new AriadneRuntime({ host: recorder.host(host), provider: recorder.provider(provider), grant: grant(), statePath: join(dir, 'state'), environment: 'fixture_atomic' }).run(fixed);
  const path = join(dir, 'trace.json'); recorder.save(path, fixed, provider, outcome); await host.close();
  const text = readFileSync(path, 'utf8'); assert.ok(!text.includes(fixed.inputs.email)); assert.ok(!text.includes('synthetic-old-screen-value'));
  assert.throws(() => new ReplayDriver(path), /replayable/);
});
test('replay rejects changed Task input even when runtime catches the mismatch', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ariadne-replay-drift-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fixed = task(); fixed.slots[0]!.meaning = 'メール'; const provider = new ExactLabelProvider(); const recorder = new TraceRecorder(true);
  const host = new FakeHost({ fixture: new FakeFixture(nodes()), grant: grant(), journalPath: join(dir, 'journal') });
  const outcome = await new AriadneRuntime({ host: recorder.host(host), provider: recorder.provider(provider), grant: grant(), statePath: join(dir, 'state'), environment: 'fixture_atomic' }).run(fixed);
  const path = join(dir, 'trace.json'); recorder.save(path, fixed, provider, outcome); await host.close();
  const driver = new ReplayDriver(path); fixed.inputs.email = 'changed';
  await new AriadneRuntime({ host: driver.host, provider: driver.provider(), grant: grant(), statePath: join(dir, 'replay-state'), environment: 'fixture_atomic' }).run(fixed);
  assert.throws(() => driver.assertConsumed(), /arguments differ/);
});
