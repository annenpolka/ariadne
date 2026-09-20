import { closeSync, constants, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { HostError, type Host, type TaskSpec } from './contracts.js';
import type { BindingProvider, BindingRequest, BindingBatch } from './providers/binding.js';
import type { RunOutcome } from './core/runtime.js';

type ErrorRecord = { message: string; hostCode?: HostError['code'] };
export interface Exchange { channel: 'host' | 'provider'; method: string; args: unknown[]; result?: unknown; error?: ErrorRecord }
export interface ReplayTrace {
  version: 1; mode: 'replayable'; task: TaskSpec;
  provider: { kind: BindingProvider['kind']; executionScope?: 'fixture' | 'profile' };
  exchanges: Exchange[]; outcome?: RunOutcome;
}
/** Private atomic output. Callers decide explicitly whether raw inputs may be retained. */
export function writePrivateJSON(path: string, value: unknown, space: 0 | 2 = 2): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`; let fd: number | undefined;
  try {
    fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, JSON.stringify(value, null, space) + '\n'); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temporary, path);
    const directory = openSync(dirname(path), 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch (error) { if (fd !== undefined) closeSync(fd); try { unlinkSync(temporary); } catch { /* may already be renamed */ } throw error; }
}
export class TraceRecorder {
  readonly exchanges: Exchange[] = [];
  constructor(readonly replayable: boolean) {}
  private async call<T>(channel: Exchange['channel'], method: string, args: unknown[], work: () => Promise<T>): Promise<T> {
    const entry: Exchange = { channel, method, args: this.replayable ? structuredClone(args) : [] }; this.exchanges.push(entry);
    try {
      const result = await work(); entry.result = this.replayable ? structuredClone(result ?? null) : metadata(result); return result;
    } catch (error) {
      entry.error = { message: this.replayable && error instanceof Error ? error.message : 'Operation failed', ...(error instanceof HostError ? { hostCode: error.code } : {}) }; throw error;
    }
  }
  host(host: Host): Host {
    return {
      openSession: task => this.call('host', 'openSession', [task], () => host.openSession(task)),
      capture: query => this.call('host', 'capture', [query ?? 'editable_fields'], () => host.capture(query)),
      prepare: request => this.call('host', 'prepare', [request], () => host.prepare(request)),
      commit: preparedId => this.call('host', 'commit', [preparedId], () => host.commit(preparedId)),
      status: operationId => this.call('host', 'status', [operationId], () => host.status(operationId)),
      cancel: () => this.call('host', 'cancel', [], () => host.cancel()),
      close: () => this.call('host', 'close', [], () => host.close()),
    };
  }
  provider(provider: BindingProvider): BindingProvider {
    return { kind: provider.kind, ...(provider.executionScope ? { executionScope: provider.executionScope } : {}), bind: input => this.call('provider', 'bind', [{ task: input.task, observation: input.observation }], () => provider.bind(input)) };
  }
  save(path: string, task: TaskSpec, provider: BindingProvider, outcome: RunOutcome): void {
    if (this.exchanges.some(e => !Object.hasOwn(e, 'result') && !e.error)) throw new Error('Trace contains unfinished calls and cannot be replayed');
    if (this.replayable) writePrivateJSON(path, { version: 1, mode: 'replayable', task, provider: { kind: provider.kind, ...(provider.executionScope ? { executionScope: provider.executionScope } : {}) }, exchanges: this.exchanges, outcome } satisfies ReplayTrace);
    else writePrivateJSON(path, { version: 1, mode: 'metadata', taskId: task.taskId, taskRevision: task.revision, scopeRef: task.scopeRef, exchanges: this.exchanges, result: outcome.result, trace: outcome.trace, remaining: outcome.handoff?.remaining ?? null });
  }
}
function metadata(value: unknown): unknown {
  if (!value || typeof value !== 'object') return null;
  const object = value as Record<string, unknown>;
  const fields = ['kind', 'schemaVersion', 'taskId', 'taskRevision', 'sessionEpoch', 'controlEpoch', 'scopeRef', 'grantRef', 'grantVersion', 'observationId', 'preparedId', 'operationId', 'status', 'reason', 'unresolvedOperationIds'];
  return Object.fromEntries(fields.filter(key => Object.hasOwn(object, key)).map(key => [key, object[key]]));
}

/** Replays recorded call results locally; this never calls a model or an OS host. */
export class ReplayDriver {
  private index = 0;
  private divergence: Error | undefined;
  private readonly operations = new Map<string, string>();
  readonly trace: ReplayTrace;
  constructor(path: string) {
    const raw = readFileSync(path, 'utf8'); if (Buffer.byteLength(raw) > 32 * 1024 * 1024) throw new Error('Replay trace is oversized');
    const value = JSON.parse(raw) as ReplayTrace;
    if (value.version !== 1 || value.mode !== 'replayable' || !Array.isArray(value.exchanges) || !value.provider || !['deterministic', 'semantic'].includes(value.provider.kind)) throw new Error('A complete replayable trace is required');
    if (value.exchanges.some(e => !e || !['host', 'provider'].includes(e.channel) || typeof e.method !== 'string' || !Array.isArray(e.args) || (Object.hasOwn(e, 'result') === Object.hasOwn(e, 'error')))) throw new Error('Invalid or incomplete replay exchange');
    this.trace = value;
  }
  private async call(channel: Exchange['channel'], method: string, args: unknown[]): Promise<unknown> {
    const entry = this.trace.exchanges[this.index++];
    if (!entry || entry.channel !== channel || entry.method !== method) { this.divergence = new Error(`Replay diverged at ${channel}.${method}`); throw this.divergence; }
    const normalized = structuredClone(args);
    if (method === 'prepare') {
      const actual = normalized[0] as { operationId: string }; const recorded = entry.args[0] as { operationId: string };
      this.operations.set(recorded.operationId, actual.operationId); actual.operationId = recorded.operationId;
    }
    if (method === 'status') normalized[0] = [...this.operations].find(([, actual]) => actual === normalized[0])?.[0] ?? normalized[0];
    if (!isDeepStrictEqual(normalized, entry.args)) { this.divergence = new Error(`Replay arguments differ at ${channel}.${method}`); throw this.divergence; }
    if (entry.error) { if (entry.error.hostCode) throw new HostError(entry.error.hostCode, entry.error.message); throw new Error(entry.error.message); }
    const value = structuredClone(entry.result);
    if (value && typeof value === 'object' && 'operationId' in value && typeof value.operationId === 'string') value.operationId = this.operations.get(value.operationId) ?? value.operationId;
    return value;
  }
  readonly host: Host = {
    openSession: task => this.call('host', 'openSession', [task]) as ReturnType<Host['openSession']>,
    capture: query => this.call('host', 'capture', [query ?? 'editable_fields']) as ReturnType<Host['capture']>,
    prepare: request => this.call('host', 'prepare', [request]) as ReturnType<Host['prepare']>,
    commit: preparedId => this.call('host', 'commit', [preparedId]) as ReturnType<Host['commit']>,
    status: operationId => this.call('host', 'status', [operationId]) as ReturnType<Host['status']>,
    cancel: async () => { await this.call('host', 'cancel', []); },
    close: async () => { await this.call('host', 'close', []); },
  };
  provider(): BindingProvider {
    return { ...this.trace.provider, bind: (input: BindingRequest) => this.call('provider', 'bind', [{ task: input.task, observation: input.observation }]) as Promise<BindingBatch> };
  }
  assertConsumed(): void { if (this.divergence) throw this.divergence; if (this.index !== this.trace.exchanges.length) throw new Error('Replay did not consume the entire recorded route'); }
}
