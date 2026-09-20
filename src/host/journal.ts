import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { HostReceipt } from '../contracts.js';
import { HostError } from '../contracts.js';
import { validateContract } from '../validation.js';
import { acquireFileLock } from '../locking.js';

export type JournalEvent =
  | { type: 'boot'; epoch: string }
  | { type: 'task'; taskId: string; revision: number; digest: string; deadlineWallMs: number; lastWallMs: number }
  | { type: 'intent'; taskId: string; taskRevision: number; scopeRef: string; operationId: string; requestDigest: string; receipt: HostReceipt }
  | { type: 'receipt'; operationId: string; receipt: HostReceipt };
export interface JournalTask { digest: string; deadlineWallMs: number; lastWallMs: number; operations: number }
export interface JournalOperation { taskId: string; taskRevision: number; scopeRef: string; requestDigest: string; receipt: HostReceipt }
export interface JournalState { epoch: string | null; tasks: Map<string, JournalTask>; operations: Map<string, JournalOperation> }
export const taskKey = (taskId: string, revision: number): string => JSON.stringify([taskId, revision]);
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Short synchronous transactions serialize the actual driver boundary across hosts. */
export class DispatchJournal {
  constructor(readonly path: string) { mkdirSync(dirname(path), { recursive: true }); }
  transaction<T>(fn: (state: JournalState, append: (event: JournalEvent) => void) => T): T {
    const release = this.lock(); let fd: number | undefined;
    try {
      if (existsSync(this.path) && lstatSync(this.path).isSymbolicLink()) throw new HostError('journal_error', 'Journal cannot be a symbolic link');
      const created = !existsSync(this.path);
      fd = openSync(this.path, constants.O_CREAT | constants.O_APPEND | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      const bytes = readFileSync(fd, 'utf8');
      if (bytes.length > 16 * 1024 * 1024 || (bytes.length > 0 && !bytes.endsWith('\n'))) throw new HostError('journal_error', 'Journal is oversized or truncated');
      const state: JournalState = { epoch: null, tasks: new Map(), operations: new Map() }; let sequence = 0;
      for (const line of bytes.split('\n').slice(0, -1)) {
        let parsed: unknown;
        try { parsed = JSON.parse(line); } catch { throw new HostError('journal_error', 'Malformed journal'); }
        if (!record(parsed) || parsed['version'] !== 1 || parsed['sequence'] !== ++sequence) throw new HostError('journal_error', 'Invalid journal version or sequence');
        this.apply(state, parsed as unknown as JournalEvent);
      }
      if (created) { fsyncSync(fd); const directory = openSync(dirname(this.path), 'r'); try { fsyncSync(directory); } finally { closeSync(directory); } }
      const append = (event: JournalEvent) => {
        const next: JournalState = { epoch: state.epoch, tasks: new Map([...state.tasks].map(([k, v]) => [k, { ...v }])), operations: new Map([...state.operations].map(([k, v]) => [k, structuredClone(v)])) };
        this.apply(next, event);
        writeFileSync(fd!, JSON.stringify({ version: 1, sequence: sequence + 1, ...event }) + '\n'); fsyncSync(fd!); sequence++;
        state.epoch = next.epoch; state.tasks = next.tasks; state.operations = next.operations;
      };
      return fn(state, append);
    } catch (error) {
      if (error instanceof HostError) throw error;
      throw new HostError('journal_error', error instanceof Error ? error.message : 'Journal I/O failed');
    } finally { try { if (fd !== undefined) closeSync(fd); } finally { release(); } }
  }
  private apply(state: JournalState, event: JournalEvent): void {
    if (!record(event)) throw new HostError('journal_error', 'Invalid journal record');
    const invalid = (): never => { throw new HostError('journal_error', 'Invalid journal record or state transition'); };
    const allowed: Record<JournalEvent['type'], string[]> = {
      boot: ['epoch'], task: ['taskId', 'revision', 'digest', 'deadlineWallMs', 'lastWallMs'],
      intent: ['taskId', 'taskRevision', 'scopeRef', 'operationId', 'requestDigest', 'receipt'], receipt: ['operationId', 'receipt'],
    };
    if (!Object.hasOwn(allowed, event.type) || Object.keys(event).some(key => !['type', 'version', 'sequence', ...allowed[event.type]].includes(key))) invalid();
    switch (event.type) {
      case 'boot': if (!validId(event.epoch)) invalid(); state.epoch = event.epoch; return;
      case 'task': {
        if (!validId(event.taskId) || !natural(event.revision) || event.revision < 1 || !/^[a-f0-9]{64}$/.test(event.digest) || !natural(event.deadlineWallMs) || !natural(event.lastWallMs)) invalid();
        const key = taskKey(event.taskId, event.revision); const prior = state.tasks.get(key);
        if (prior && (prior.digest !== event.digest || event.deadlineWallMs > prior.deadlineWallMs || event.lastWallMs < prior.lastWallMs)) invalid();
        state.tasks.set(key, { digest: event.digest, deadlineWallMs: event.deadlineWallMs, lastWallMs: event.lastWallMs, operations: prior?.operations ?? 0 }); return;
      }
      case 'intent': {
        if (!validId(event.operationId) || !validId(event.scopeRef) || !/^[a-f0-9]{64}$/.test(event.requestDigest)) invalid();
        const task = state.tasks.get(taskKey(event.taskId, event.taskRevision)); if (!task || state.operations.has(event.operationId)) return invalid();
        validateContract(event.receipt);
        if (event.receipt.kind !== 'host_receipt' || event.receipt.operationId !== event.operationId || event.receipt.status !== 'dispatch_intent' || event.receipt.sessionEpoch !== state.epoch) invalid();
        task.operations++;
        state.operations.set(event.operationId, { taskId: event.taskId, taskRevision: event.taskRevision, scopeRef: event.scopeRef, requestDigest: event.requestDigest, receipt: structuredClone(event.receipt) }); return;
      }
      case 'receipt': {
        const operation = state.operations.get(event.operationId); if (!operation) return invalid(); validateContract(event.receipt);
        if (event.receipt.operationId !== event.operationId || event.receipt.sessionEpoch !== operation.receipt.sessionEpoch || !['attempted', 'outcome_unknown'].includes(event.receipt.status) || !['dispatch_intent', 'outcome_unknown'].includes(operation.receipt.status) || (operation.receipt.status === 'outcome_unknown' && event.receipt.status !== 'outcome_unknown')) invalid();
        operation.receipt = structuredClone(event.receipt); return;
      }
      default: return invalid();
    }
  }
  private lock(): () => void { return acquireFileLock(`${this.path}.lock`); }
}
