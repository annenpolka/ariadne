import { createInterface } from 'node:readline';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import type { BrowserActionTask, DocumentStamp, ReadObservation, ScopeGrant } from './contracts.js';
import { RpcHost, browserOperationId } from './host/rpc-host.js';
import { validateContract } from './validation.js';
import { validateGrant } from './grants.js';
import { writePrivateJSON } from './trace.js';

/** Literal screen checks, explicitly not a claim about a remote service's state. */
export function checkActionObservation(task: BrowserActionTask, observation: ReadObservation) {
  validateContract(task); validateContract(observation);
  if (observation.scopeRef !== task.scopeRef) throw new Error('Foreign check observation');
  return task.requiredChecks.map(check => {
    const evidence = observation.nodes.flatMap(node => {
      const value = node[check.attribute];
      return value.status === 'available' && (check.match === 'equals' ? value.value === check.text : value.value.includes(check.text))
        ? [{ observationId: observation.observationId, nodeRef: node.ref, field: check.attribute }] : [];
    });
    return { checkId: check.id, status: evidence.length ? 'pass' : 'unknown', evidence };
  });
}

/** JSONL operator interface. Each target is an explicit ref from this live host. */
export async function browserActionConsole(host: RpcHost, suppliedTask: BrowserActionTask, grant: ScopeGrant,
                                         outDir: string, options: { raw: boolean; record: boolean }) {
  const task = structuredClone(suppliedTask);
  validateContract(task); validateGrant(grant);
  if (!isDeepStrictEqual(grant.actionPolicy?.task, task)) throw new Error('Task differs from operator grant');
  const session = await host.openAct(task);
  let document: DocumentStamp = session.document;
  const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
  emit({ status: 'action_session', ...session, taskId: task.taskId, modelCalls: 0 });
  const lines = createInterface({ input: process.stdin, terminal: false });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        const input: unknown = JSON.parse(line);
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected command object');
        const q = input as Record<string, unknown>;
        const fields: Record<string, string[]> = { observe: ['nativeRoles', 'nameIncludes'], refresh: [], prepare: ['stepId', 'observationId', 'targetRef'], step: ['stepId', 'observationId', 'targetRef'], commit: ['preparedId'], status: ['operationId'], verify: [], cancel: [], close: [] };
        if (typeof q.command !== 'string' || !Object.hasOwn(fields, q.command) || Object.keys(q).some(k => k !== 'command' && !fields[q.command as string]!.includes(k))) throw new Error('Invalid action console command');
        const str = (key: string) => { if (typeof q[key] !== 'string') throw new Error(`Missing ${key}`); return q[key] as string; };
        if (q.command === 'close') { emit({ status: 'closed' }); break; }
        if (q.command === 'cancel') { await host.cancel(); emit({ status: 'cancelled' }); continue; }
        if (q.command === 'refresh') { document = await host.refreshPage(); emit({ document }); continue; }
        if (q.command === 'status') { emit(await host.status(str('operationId'))); continue; }
        if (q.command === 'prepare' || q.command === 'step') {
          const p = await host.prepareAction(str('stepId'), str('observationId'), str('targetRef'));
          if (options.record) writePrivateJSON(join(outDir, `${p.preparedId}.json`), p);
          if (q.command === 'prepare') emit(options.raw ? p : { status: 'prepared', preparedId: p.preparedId, operationId: p.operationId, kind: p.command.kind });
          else emit(await host.commitAction(p.preparedId));
          continue;
        }
        if (q.command === 'commit') { emit(await host.commitAction(str('preparedId'))); continue; }
        const observation = await host.read(document);
        if (options.record) writePrivateJSON(join(outDir, `${observation.observationId}.json`), observation);
        if (q.command === 'verify') {
          const checks = checkActionObservation(task, observation);
          const receipts = await Promise.all(task.steps.map(step => host.status(browserOperationId(task, step.id))));
          const unknown = !!session.unresolvedOperationIds?.length || receipts.some(r => r && ['dispatch_intent', 'outcome_unknown'].includes(r.status));
          const status = unknown ? 'outcome_unknown' : receipts.every(r => r?.status === 'attempted') && checks.every(c => c.status === 'pass') ? 'observed_success' : 'incomplete';
          const result = { status, taskId: task.taskId, taskRevision: task.revision, assurance: 'screen_only', checks,
            attemptedSteps: receipts.filter(r => r?.status === 'attempted').length, coverage: observation.coverage.status, modelCalls: 0 };
          writePrivateJSON(join(outDir, 'result.json'), result); emit(result);
        } else {
          for (const key of ['nativeRoles', 'nameIncludes']) if (q[key] !== undefined && (!Array.isArray(q[key]) || (q[key] as unknown[]).some(x => typeof x !== 'string'))) throw new Error(`Invalid ${key}`);
          const filtered = observation.nodes.filter(node => (!q.nativeRoles || (q.nativeRoles as string[]).includes(node.nativeRole)) && (!q.nameIncludes || node.name.status === 'available' && (q.nameIncludes as string[]).some(s => node.name.status === 'available' && node.name.value.includes(s))));
          emit({ status: 'observed', observationId: observation.observationId, document: observation.document,
            coverage: observation.coverage, ...(options.raw ? { nodes: filtered } : { nodes: observation.nodes.length, displayed: filtered.length }) });
        }
      } catch (error) { emit({ status: 'error', code: error && typeof error === 'object' && 'code' in error ? error.code : 'invalid_request', message: error instanceof Error ? error.message : 'failed' }); }
    }
  } finally { lines.close(); await host.close(); }
}
