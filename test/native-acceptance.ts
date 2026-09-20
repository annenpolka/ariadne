/** Opt-in real AX test. It creates and terminates only its own synthetic fixture process. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { RpcHost } from '../src/host/rpc-host.js';
import { ExactLabelProvider, makeBinding } from '../src/providers/binding.js';
import { AriadneRuntime } from '../src/core/runtime.js';
import { writePrivateJSON } from '../src/trace.js';
import { grant, task } from './helpers.js';
import type { PreparedOperation } from '../src/contracts.js';

const root = resolve(process.env['ARIADNE_NATIVE_TEST_DIR'] ?? `.runtime/native-acceptance-${randomUUID()}`);
mkdirSync(root, { recursive: true });
const observations: { scenario: string; result: string; elapsedMs: number }[] = [];
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const binary = resolve('.cache/swift/debug/AriadneHost');
const fixed = task(); fixed.slots[0]!.meaning = 'メール';
writePrivateJSON(join(root, 'grant.json'), grant()); writePrivateJSON(join(root, 'task.json'), fixed);

const allScenarios = ['normal', 'after_intent', 'after_dispatch', 'response_lost', 'journal_error', 'invoke', 'replacement', 'modal', 'cancel', 'cancel-race', 'disabled'];
const scenarios = process.env['ARIADNE_NATIVE_SCENARIOS']?.split(',') ?? allScenarios;
assert.ok(scenarios.every(s => allScenarios.includes(s)));
for (const scenario of scenarios) {
  const start = performance.now(); const directory = join(root, scenario); mkdirSync(directory);
  const oraclePath = join(directory, 'oracle.json');
  const fixture = spawn(resolve('.cache/swift/debug/AriadneFixture'), ['--oracle', oraclePath, '--read-delay-file', join(directory, 'delay.json'), '--exit-after', '60'], { stdio: 'ignore' });
  const exited = once(fixture, 'exit'); let host: RpcHost | undefined;
  const oracle = () => JSON.parse(readFileSync(oraclePath, 'utf8')) as { pid: number; contactEmail: string; shippingEmail: string; submissions: number; axSets: number; generation: number };
  const scope = { ...grant(), allowedActions: ['fixture.submit', 'fixture.replace_field', 'fixture.show_modal'] as const };
  writePrivateJSON(join(directory, 'grant.json'), scope);
  const connect = (fault?: string) => new RpcHost({ executable: binary, args: ['--pid', String(fixture.pid), '--window-title', 'Ariadne Fixture', '--grant', join(directory, 'grant.json'), '--journal', join(directory, 'host.jsonl')], timeoutMs: 2500, env: { ...process.env, ARIADNE_FAULT: fault ?? '' }, onDiagnostic: message => process.stderr.write(message) });
  try {
    for (let attempt = 0; !existsSync(oraclePath) && attempt < 100; attempt++) await sleep(50);
    assert.ok(existsSync(oraclePath), 'fixture must start and write independent oracle'); assert.equal(oracle().pid, fixture.pid);
    host = connect(scenario === 'normal' ? undefined : scenario);
    let session;
    for (let retry = 0; retry < 40; retry++) {
      try { session = await host.openSession(fixed); break; }
      catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'scope_denied') || retry === 39) throw error; await sleep(50); }
    }
    assert.ok(session); const before = await host.capture(); const second = await host.capture();
    const provider = new ExactLabelProvider(); const input = { task: fixed, observation: before, signal: new AbortController().signal };
    const batch = await provider.bind(input); assert.equal(batch.bindings.length, 1, 'real AX region must disambiguate same-named email fields');
    const binding = batch.bindings[0]!;
    assert.ok(second.nodes.some(node => node.ref === binding.targetRef), 'unchanged native object must retain ref across captures');
    writePrivateJSON(join(directory, 'observed.json'), before);
    if (scenario === 'normal') {
      const result = await new AriadneRuntime({ host, provider, grant: grant(), statePath: join(directory, 'state.json'), environment: 'external_best_effort' }).run(fixed);
      writePrivateJSON(join(directory, 'result.json'), result); assert.equal(result.result.status, 'verified_success', JSON.stringify(result.handoff));
      await sleep(150); assert.equal(oracle().contactEmail, fixed.inputs.email); assert.equal(oracle().shippingEmail, ''); assert.equal(oracle().submissions, 0);
      assert.equal(oracle().axSets, 1, 'independent fixture counts actual AX setter entries');
    } else if (['invoke', 'replacement', 'modal', 'cancel', 'cancel-race', 'disabled'].includes(scenario)) {
      if (scenario === 'disabled') {
        const disabled = before.nodes.find(n => n.name.status === 'available' && n.name.value === 'Disabled')!;
        assert.ok(disabled);
        await assert.rejects(host.prepare({ operationId: 'op-disabled', taskId: fixed.taskId, taskRevision: 1, sessionEpoch: session.sessionEpoch, binding: makeBinding('contactEmail', disabled.ref, before, 'operator'), command: { kind: 'set_value', targetRef: disabled.ref, value: fixed.inputs.email! } }));
      } else {
        const field = await host.prepare({ operationId: 'op-field', taskId: fixed.taskId, taskRevision: 1, sessionEpoch: session.sessionEpoch, binding, command: { kind: 'set_value', targetRef: binding.targetRef, value: fixed.inputs.email! } });
        if (scenario === 'cancel') {
          await host.cancel(); assert.equal((await host.commit(field.preparedId)).status, 'not_dispatched');
        } else if (scenario === 'cancel-race') {
          writePrivateJSON(join(directory, 'delay.json'), { delayOnRead: 3, milliseconds: 800 });
          const committing = host.commit(field.preparedId);
          let enteredIntent = false;
          for (let retry = 0; retry < 100; retry++) {
            if (existsSync(join(directory, 'delay.json.entered')) && readFileSync(join(directory, 'host.jsonl'), 'utf8').includes('dispatch_intent')) { enteredIntent = true; break; }
            await sleep(5);
          }
          assert.ok(enteredIntent, 'must cancel while the real AX getter is delayed after durable intent');
          const oldOpen = assert.rejects(host.openSession(fixed), { code: 'cancelled' });
          const cancelling = performance.now(); await host.cancel();
          assert.ok(performance.now() - cancelling < 400, 'control reader must acknowledge while the AX worker is delayed');
          assert.equal((await committing).status, 'outcome_unknown');
          await oldOpen;
        } else {
          const title = scenario === 'invoke' ? 'Submit' : scenario === 'replacement' ? 'Replace field' : 'Show modal';
          const button = before.nodes.find(n => n.name.status === 'available' && n.name.value === title)!; assert.ok(button?.capabilities.includes('invoke'));
          const action = await host.prepare({ operationId: 'op-button', taskId: fixed.taskId, taskRevision: 1, sessionEpoch: session.sessionEpoch, binding: makeBinding('contactEmail', button.ref, before, 'operator'), command: { kind: 'invoke', targetRef: button.ref } });
          const receipts = await Promise.all(Array.from({ length: 5 }, () => host!.commit(action.preparedId)));
          assert.ok(receipts.every(r => r.status === 'attempted')); await sleep(150);
          if (scenario === 'invoke') assert.equal(oracle().submissions, 1);
          else {
            assert.equal((await host.commit(field.preparedId)).status, 'not_dispatched');
            if (scenario === 'replacement') { assert.equal(oracle().generation, 2); assert.ok(!(await host.capture()).nodes.some(n => n.ref === binding.targetRef)); }
            else assert.ok((await host.capture('active_dialog')).nodes.some(n => n.role === 'dialog'));
          }
        }
      }
      await sleep(150); assert.equal(oracle().axSets, 0); assert.equal(oracle().contactEmail, ''); assert.equal(oracle().shippingEmail, '');
    } else {
      const operation: PreparedOperation = await host.prepare({ operationId: 'op-native-fault', taskId: fixed.taskId, taskRevision: fixed.revision, sessionEpoch: session.sessionEpoch, binding, command: { kind: 'set_value', targetRef: binding.targetRef, value: fixed.inputs.email! } });
      let receipt; let commitError: unknown;
      try { receipt = await host.commit(operation.preparedId); } catch (error) { commitError = error; }
      if (scenario === 'response_lost') {
        assert.ok(commitError); assert.equal((await host.status(operation.operationId))?.status, 'attempted');
        assert.equal((await host.commit(operation.preparedId)).status, 'attempted');
      } else if (scenario === 'journal_error') {
        assert.ok(commitError || receipt?.status === 'not_dispatched');
      } else {
        assert.ok(commitError, 'fault must terminate the actual host process');
        await host.close().catch(() => undefined); host = connect();
        assert.equal((await host.status(operation.operationId))?.status, 'outcome_unknown');
        const resumed = await host.openSession(fixed); assert.deepEqual(resumed.unresolvedOperationIds, [operation.operationId]);
        const fresh = await host.capture();
        const nextBinding = (await provider.bind({ ...input, observation: fresh })).bindings[0]!;
        await assert.rejects(host.prepare({ operationId: 'op-new-after-crash', taskId: fixed.taskId, taskRevision: 1, sessionEpoch: resumed.sessionEpoch, binding: nextBinding, command: { kind: 'set_value', targetRef: nextBinding.targetRef, value: fixed.inputs.email! } }), { code: 'outcome_unknown' });
      }
      await sleep(150);
      assert.equal(oracle().contactEmail, scenario === 'after_intent' || scenario === 'journal_error' ? '' : fixed.inputs.email);
      assert.equal(oracle().shippingEmail, ''); assert.equal(oracle().submissions, 0);
      assert.equal(oracle().axSets, scenario === 'after_intent' || scenario === 'journal_error' ? 0 : 1);
      const rows = readFileSync(join(directory, 'host.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { type: string });
      assert.equal(rows.filter(row => row.type === 'intent').length, scenario === 'journal_error' ? 0 : 1);
    }
    observations.push({ scenario, result: 'passed', elapsedMs: Math.round(performance.now() - start) });
  } catch (error) {
    observations.push({ scenario, result: error instanceof Error ? error.message : 'failed', elapsedMs: Math.round(performance.now() - start) });
    writePrivateJSON(join(root, 'report.json'), observations); throw error;
  } finally {
    await host?.close().catch(() => undefined); fixture.kill('SIGTERM'); await exited;
  }
}
writePrivateJSON(join(root, 'report.json'), observations);
process.stdout.write(JSON.stringify({ root, scenarios: observations }) + '\n');
