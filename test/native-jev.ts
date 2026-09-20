import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { RpcHost } from '../src/host/rpc-host.js';
import { JevBindingProvider, type Calibration } from '../src/providers/jev.js';
import { AriadneRuntime } from '../src/core/runtime.js';
import { writePrivateJSON } from '../src/trace.js';
import { grant, task } from './helpers.js';

const root = resolve(`.runtime/native-jev-${Date.now()}`); mkdirSync(root, { recursive: true });
const oracle = join(root, 'oracle.json');
const fixture = spawn(resolve('.cache/swift/debug/AriadneFixture'), ['--oracle', oracle, '--exit-after', '60'], { stdio: 'ignore' }); const exited = once(fixture, 'exit');
const scope = { ...grant(), model: true }; const fixed = task();
fixed.inputs.shipping = 'delivery@example.invalid';
fixed.slots.push({ id: 'shippingEmail', meaning: '配送状況の通知を受けるメールアドレス', inputRef: 'shipping', regionHint: '配送通知先' });
fixed.requiredChecks.push({ id: 'check-shipping', kind: 'value_equals_input', slotId: 'shippingEmail', inputRef: 'shipping', comparison: 'exact' });
writePrivateJSON(join(root, 'grant.json'), scope); writePrivateJSON(join(root, 'task.json'), fixed);
let host: RpcHost | undefined;
try {
  for (let i = 0; !existsSync(oracle) && i < 100; i++) await new Promise(r => setTimeout(r, 50));
  assert.ok(existsSync(oracle));
  host = new RpcHost({ executable: resolve('.cache/swift/debug/AriadneHost'), args: ['--pid', String(fixture.pid), '--window-title', 'Ariadne Fixture', '--grant', join(root, 'grant.json'), '--journal', join(root, 'host.jsonl')] });
  const apiKey = execFileSync('/usr/bin/security', ['find-generic-password', '-s', 'typesafe-api', '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const calibration = JSON.parse(readFileSync('config/calibration.synthetic-forms-v2.json', 'utf8')) as Calibration; let calls = 0;
  const provider = new JevBindingProvider({ model: 'jev-1.13.0', apiKey, calibration, onExchange: e => { calls++; writePrivateJSON(join(root, `exchange-${calls}.json`), e); } });
  const outcome = await new AriadneRuntime({ host, provider, grant: scope, statePath: join(root, 'state.json'), environment: 'external_best_effort' }).run(fixed);
  writePrivateJSON(join(root, 'outcome.json'), outcome);
  assert.equal(outcome.result.status, 'verified_success', JSON.stringify(outcome.handoff)); assert.equal(calls, 1);
  await new Promise(r => setTimeout(r, 150));
  const truth = JSON.parse(readFileSync(oracle, 'utf8')) as { contactEmail: string; shippingEmail: string; submissions: number; axSets: number };
  assert.equal(truth.contactEmail, fixed.inputs.email); assert.equal(truth.shippingEmail, fixed.inputs.shipping); assert.equal(truth.submissions, 0); assert.equal(truth.axSets, 2);
  process.stdout.write(JSON.stringify({ root, model: 'jev-1.13.0', semanticRequests: calls, status: outcome.result.status, oracle: 'matched', actualAXSets: truth.axSets }) + '\n');
} finally { await host?.close().catch(() => undefined); fixture.kill('SIGTERM'); await exited; }
