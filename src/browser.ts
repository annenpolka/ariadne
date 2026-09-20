#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { RpcHost } from './host/rpc-host.js';
import { writePrivateJSON } from './trace.js';
import { browserOrigin, canonicalOrigin, chromeAppId, defaultReadLimits, validateReadLimits } from './browser-policy.js';
import { validateGrant } from './grants.js';
import { runReadTask } from './read-task.js';
import { defaultProjectionLimits } from './browser-limits.generated.js';
import { browserActionConsole } from './browser-actions.js';
import type { BrowserActionTask } from './contracts.js';
import type { ScopeGrant, ReadSessionSpec, ReadTaskSpec, TextAttribute } from './contracts.js';

const chromeExecutable = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
type Launch = { pid: number; profile: string; args: string[] };
type WindowState = { status: string; pid?: number; url?: string; title?: string; windowCount?: number };

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    origin: { type: 'string', multiple: true }, raw: { type: 'boolean' }, record: { type: 'boolean' },
    'max-nodes': { type: 'string' }, 'max-depth': { type: 'string' }, 'max-bytes': { type: 'string' },
    'max-capture-ms': { type: 'string' },
    role: { type: 'string', multiple: true }, attribute: { type: 'string', multiple: true },
    'max-records': { type: 'string' }, 'max-output-bytes': { type: 'string' },
    task: { type: 'string' }, grant: { type: 'string' },
  } });
  const [command, target] = positionals;
  if (positionals.length !== 2 || !['open', 'read', 'extract', 'status', 'act'].includes(command ?? '')) throw new Error('Usage: npm run browser -- open URL | status SESSION_DIR --origin ORIGIN | read|extract SESSION_DIR --origin ORIGIN [--raw] [--record] [--max-nodes N] [--max-depth N] [--max-bytes N] [--max-capture-ms N] | act SESSION_DIR --origin ORIGIN --task FILE --grant FILE [--raw] [--record]; extract also accepts [--role AXStaticText] [--attribute name|value] [--max-records N] [--max-output-bytes N]');
  if (command !== 'act' && (values.task || values.grant)) throw new Error('Task and grant options require act');
  if (command !== 'extract' && ['role', 'attribute', 'max-records', 'max-output-bytes'].some(key => Object.hasOwn(values, key))) throw new Error('Projection options require extract');
  const attributes = values.attribute ?? ['name', 'value'];
  if (attributes.some(a => a !== 'name' && a !== 'value')) throw new Error('Only name/value attributes can be projected');
  if (command === 'open') {
    if (Object.keys(values).length || !browserOrigin(target!)) throw new Error('open requires an HTTPS URL or an HTTP 127.0.0.1 URL');
    mkdirSync('.runtime', { recursive: true, mode: 0o700 });
    const root = resolve(mkdtempSync('.runtime/browser-session-'));
    const profile = join(root, 'profile'); mkdirSync(profile, { mode: 0o700 });
    const args = [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-extensions', '--disable-background-networking', '--force-renderer-accessibility', '--new-window', target!];
    const browser = spawn(chromeExecutable, args, { detached: true, stdio: 'ignore' });
    await once(browser, 'spawn');
    if (!browser.pid) throw new Error('Chrome did not start');
    writePrivateJSON(join(root, 'launch.json'), { pid: browser.pid, profile, args });
    browser.unref();
    process.stdout.write(JSON.stringify({ status: 'opened', root, pid: browser.pid }) + '\n');
    return;
  }
  const origins = values.origin?.map(canonicalOrigin);
  if (!origins?.length || origins.length > 16 || new Set(origins).size !== origins.length) throw new Error('Specify 1–16 distinct canonical --origin values');
  const root = resolve(target!);
  const launch = JSON.parse(readFileSync(join(root, 'launch.json'), 'utf8')) as Launch;
  if (!Number.isSafeInteger(launch.pid) || launch.pid <= 0 || launch.profile !== join(root, 'profile') || !Array.isArray(launch.args) || launch.args.some(x => typeof x !== 'string')) throw new Error('Invalid dedicated Chrome receipt');
  // Only inspect the process named by the receipt, without reading profile contents.
  const actual = execFileSync('/bin/ps', ['-p', String(launch.pid), '-o', 'command='], { encoding: 'utf8' }).trim();
  if (actual !== [chromeExecutable, ...launch.args].join(' ') || !launch.args.includes(`--user-data-dir=${launch.profile}`)) throw new Error('Dedicated Chrome identity changed');
  const selected = JSON.parse(execFileSync('swift', ['scripts/browser-window.swift', String(launch.pid), ...origins], { encoding: 'utf8', timeout: 20_000 })) as WindowState;
  if (selected.status !== 'browser_window') {
    process.stdout.write(JSON.stringify({ status: selected.status, windowCount: selected.windowCount }) + '\n');
    process.exitCode = 2; return;
  }
  if (!selected.title || !selected.url || selected.pid !== launch.pid || !origins.includes(browserOrigin(selected.url) ?? '')) throw new Error('Browser window is outside the requested scope');
  if (command === 'status') { process.stdout.write(JSON.stringify({ status: 'browser_window', pid: launch.pid }) + '\n'); return; }
  if (command === 'act') {
    if (!values.task || !values.grant || Object.keys(values).some(k => !['origin', 'task', 'grant', 'raw', 'record'].includes(k))) throw new Error('act requires explicit task and operator grant files');
    const task = JSON.parse(readFileSync(values.task, 'utf8')) as BrowserActionTask;
    const grant = JSON.parse(readFileSync(values.grant, 'utf8')) as ScopeGrant;
    validateGrant(grant);
    if (!grant.act || grant.appId !== chromeAppId || !grant.pageScope || origins.length !== grant.pageScope.origins.length || origins.some(o => !grant.pageScope!.origins.includes(o))) throw new Error('CLI origins differ from action grant');
    // One stable journal per dedicated profile, shared with read sessions. Task
    // and origin changes never create a fresh journal to escape an unknown.
    const host = new RpcHost({ executable: resolve('.cache/swift/debug/AriadneHost'), args: ['--pid', String(launch.pid), '--window-title', selected.title, '--page-url', selected.url, '--grant', resolve(values.grant), '--journal', join(root, 'read-host.jsonl')] });
    try { await browserActionConsole(host, task, grant, join(root, `act-${task.taskId}-${task.revision}`), { raw: !!values.raw, record: !!values.record }); }
    finally { await host.close(); }
    return;
  }
  const limits = { ...defaultReadLimits,
    ...(values['max-nodes'] === undefined ? {} : { maxNodes: Number(values['max-nodes']) }),
    ...(values['max-depth'] === undefined ? {} : { maxDepth: Number(values['max-depth']) }),
    ...(values['max-bytes'] === undefined ? {} : { maxBytes: Number(values['max-bytes']) }),
    ...(values['max-capture-ms'] === undefined ? {} : { maxCaptureMs: Number(values['max-capture-ms']) }),
  }; validateReadLimits(limits);
  const spec: ReadSessionSpec = { kind: 'read_session', schemaVersion: '0.1', readSessionId: `read-${randomUUID()}`, scopeRef: `scope-${randomUUID()}`, limits };
  const grant: ScopeGrant = { scopeRef: spec.scopeRef, grantRef: `grant-${randomUUID()}`, version: 1, read: true, model: false, act: false, allowedCommands: [], appId: chromeAppId, windowRef: 'browser-page', limits: { maxOperations: 0, maxSemanticRequests: 0, maxObservationExpansions: 0, deadlineMs: limits.deadlineMs }, pageScope: { origins }, readLimits: limits };
  validateGrant(grant);
  const readDir = join(root, spec.readSessionId);
  writePrivateJSON(join(readDir, 'grant.json'), grant);
  // Read sessions share a journal path. Refresh/new observations never erase old unresolved operations.
  const host = new RpcHost({ executable: resolve('.cache/swift/debug/AriadneHost'), args: ['--pid', String(launch.pid), '--window-title', selected.title, '--page-url', selected.url, '--grant', join(readDir, 'grant.json'), '--journal', join(root, 'read-host.jsonl')] });
  try {
    const session = await host.openRead(spec);
    if (command === 'extract') {
      const task: ReadTaskSpec = { kind: 'read_task', schemaVersion: '0.1', taskId: `projection-${randomUUID()}`, revision: 1,
        recipeId: 'project-ax-text.v1', completeness: 'observed_region', readSessionId: spec.readSessionId, scopeRef: spec.scopeRef,
        document: session.document, nativeRoles: values.role ?? [], attributes: attributes as TextAttribute[],
        limits: { maxRecords: Number(values['max-records'] ?? defaultProjectionLimits.maxRecords), maxOutputBytes: Number(values['max-output-bytes'] ?? defaultProjectionLimits.maxOutputBytes) } };
      const output = await runReadTask(host, spec, session, task);
      const result = output.result;
      const attributeStates: Record<string, number> = {};
      for (const record of result.records) for (const attr of record.attributes) attributeStates[attr.status] = (attributeStates[attr.status] ?? 0) + 1;
      const report = { status: result.status, mechanism: 'AriadneHost native macOS AX', recipeId: result.recipeId, mapping: result.mapping,
        completeness: result.completeness, records: result.records.length, matchedNodeCount: result.matchedNodeCount,
        selectionUncertain: result.selectionUncertain, outputTruncated: result.outputTruncated,
        coverage: result.source.coverage.status, omittedReasons: result.source.coverage.omittedReasons, attributeStates,
        modelCalls: result.modelCalls, operations: result.operations, unresolvedOperationIds: session.unresolvedOperationIds ?? [] };
      writePrivateJSON(join(readDir, 'report.json'), report);
      if (values.record) {
        writePrivateJSON(join(readDir, 'task.json'), output.task);
        writePrivateJSON(join(readDir, 'observation.json'), output.observation);
        writePrivateJSON(join(readDir, 'result.json'), result, 0);
      }
      process.stdout.write(JSON.stringify(values.raw ? result : { ...report, readDir }, null, values.raw ? 0 : 2) + '\n');
      return;
    }
    const observation = await host.read(session.document);
    const report = { status: 'observed', mechanism: 'AriadneHost native macOS AX', document: observation.document, coverage: observation.coverage, capture: observation.capture, modelCalls: 0, operations: 0, unresolvedOperationIds: session.unresolvedOperationIds ?? [] };
    writePrivateJSON(join(readDir, 'report.json'), report);
    if (values.record) writePrivateJSON(join(readDir, 'observation.json'), observation);
    process.stdout.write(JSON.stringify(values.raw ? observation : { ...report, readDir }, null, 2) + '\n');
  } finally { await host.close(); }
}
main().catch(error => { process.stderr.write(`Browser: ${error instanceof Error ? error.message : 'failed'}\n`); process.exitCode = 1; });
