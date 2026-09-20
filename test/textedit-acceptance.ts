import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import assert from 'node:assert/strict';
import { RpcHost } from '../src/host/rpc-host.js';
import { TextEditBodyProvider } from '../src/providers/profile.js';
import { AriadneRuntime } from '../src/core/runtime.js';
import { writePrivateJSON } from '../src/trace.js';
import { grant, task } from './helpers.js';

const root = resolve(`.runtime/textedit-${Date.now()}`); mkdirSync(root, { recursive: true });
const document = join(root, `Ariadne-scratch-${Date.now()}.txt`);
writeFileSync(document, 'Ariadne synthetic scratch document.\n', { flag: 'wx', mode: 0o600 });
const pid = execFileSync('swift', ['test/launch-textedit.swift', document], { encoding: 'utf8', timeout: 30_000 }).trim();
assert.match(pid, /^[1-9][0-9]*$/);
await new Promise(resolve => setTimeout(resolve, 500));
const scope = { ...grant(), appId: 'com.apple.TextEdit', allowedCommands: ['set_value'] as ['set_value'] };
const fixed = task(); fixed.taskId = 'task-textedit'; fixed.goal = '新規の Ariadne 作業用文書の本文を置き換えて読み戻す'; fixed.slots[0]!.meaning = '文書本文'; fixed.slots[0]!.regionHint = ''; fixed.inputs.email = 'Ariadne P3 real AX check.\nこれは架空の作業用文書です。\n';
writePrivateJSON(join(root, 'grant.json'), scope); writePrivateJSON(join(root, 'task.json'), fixed);
const host = new RpcHost({ executable: resolve('.cache/swift/debug/AriadneHost'), args: ['--pid', pid, '--window-title', basename(document), '--document', document, '--grant', join(root, 'grant.json'), '--journal', join(root, 'host.jsonl')], onDiagnostic: message => process.stderr.write(message) });
try {
  await host.openSession(fixed); const observed = await host.capture(); writePrivateJSON(join(root, 'observation.json'), observed);
  const supported = observed.nodes.some(n => n.role === 'text_area' && n.capabilities.includes('set_value') && n.enabled.status === 'available' && n.enabled.value);
  const outcome = await new AriadneRuntime({ host, provider: new TextEditBodyProvider(), grant: scope, statePath: join(root, 'state.json'), environment: 'external_best_effort' }).run(fixed);
  writePrivateJSON(join(root, 'outcome.json'), outcome);
  if (supported) assert.equal(outcome.result.status, 'verified_success', JSON.stringify(outcome.handoff));
  else assert.notEqual(outcome.result.status, 'verified_success');
  const after = await host.capture(); writePrivateJSON(join(root, 'readback.json'), after);
  if (outcome.result.status === 'verified_success') assert.ok(after.nodes.some(n => n.role === 'text_area' && n.value.status === 'available' && n.value.value === fixed.inputs.email));
  process.stdout.write(JSON.stringify({ root, document, pid, supported, status: outcome.result.status, handoff: outcome.handoff }) + '\n');
} finally { await host.close(); }
