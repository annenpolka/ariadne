import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Budgets, TaskSpec } from '../contracts.js';
import { acquireFileLock } from '../locking.js';

export interface StoredTask {
  taskId: string; revision: number; digest: string; deadlineWallMs: number; lastWallMs: number;
  operations: number; semanticRequests: number; expansions: number; pendingOperationIds: string[];
}
export type CounterKind = 'operations' | 'semanticRequests' | 'expansions';
/** A lease for the whole Task execution; prevents a losing process from controlling the shared Host. */
export interface TaskLease { readonly taskId: string; readonly revision: number; release(): void }

const MAX_BYTES = 16 * 1024 * 1024;
/** setTimeout treats delays above this as 1ms, so never hand it an unbounded interval. */
const MAX_TIMEOUT_MS = 0x7fffffff;
const ENTRY_KEYS = new Set(['taskId', 'revision', 'digest', 'deadlineWallMs', 'lastWallMs', 'operations', 'semanticRequests', 'expansions', 'pendingOperationIds']);
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Canonical JSON keeps the stored digest stable regardless of key insertion order. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const source = value as Record<string, unknown>;
  return `{${Object.keys(source).sort().map(key => `${JSON.stringify(key)}:${canonical(source[key])}`).join(',')}}`;
}
export function taskDigest(task: TaskSpec): string { return createHash('sha256').update(canonical(task)).digest('hex'); }
/** Limits reach timers and counters, so reject unusable operator/budget numbers before use. */
export function validateLimits(limits: Budgets): void {
  if (!record(limits) || !['maxOperations', 'maxSemanticRequests', 'maxObservationExpansions', 'deadlineMs'].every(key => natural(limits[key as keyof Budgets]))) throw new Error('Invalid task or grant budget limits');
  if (limits.deadlineMs > MAX_TIMEOUT_MS) throw new Error('Invalid task or grant deadline limit');
}

/** Durable, process-safe Task ledger. Every mutation re-reads under an exclusive lock. */
export class TaskLedger {
  constructor(private readonly path: string) {}
  /** Whole-run lease on the state path; distinct from the short per-mutation lock. */
  acquireLease(task: TaskSpec): TaskLease {
    const release = acquireFileLock(`${this.path}.run`);
    return { taskId: task.taskId, revision: task.revision, release };
  }
  open(task: TaskSpec, limits: Budgets): Readonly<StoredTask> {
    validateLimits(limits);
    const digest = taskDigest(task);
    return this.withLock(() => {
      const entries = this.read();
      let entry = entries.find(e => e.taskId === task.taskId && e.revision === task.revision);
      if (entry && entry.digest !== digest) throw new Error('Task content changed without a new revision');
      if (!entry) {
        const now = Date.now();
        entry = { taskId: task.taskId, revision: task.revision, digest, deadlineWallMs: now + limits.deadlineMs, lastWallMs: now, operations: 0, semanticRequests: 0, expansions: 0, pendingOperationIds: [] };
        entries.push(entry); this.write(entries);
      }
      return structuredClone(entry);
    });
  }
  spend(task: TaskSpec, kind: CounterKind, limits: Budgets): Readonly<StoredTask> {
    validateLimits(limits);
    return this.withLock(() => {
      const entries = this.read(); const entry = this.find(entries, task);
      this.checkClock(entry, Date.now());
      const limitKey: Record<CounterKind, keyof Budgets> = { operations: 'maxOperations', semanticRequests: 'maxSemanticRequests', expansions: 'maxObservationExpansions' };
      if (entry[kind] >= limits[limitKey[kind]]) throw new Error(`Task budget exhausted: ${kind}`);
      entry[kind]++; entry.lastWallMs = Date.now(); this.write(entries); return structuredClone(entry);
    });
  }
  /** Spend one operation and record its pending receipt atomically before commit. */
  beginOperation(task: TaskSpec, operationId: string, limits: Budgets): Readonly<StoredTask> {
    validateLimits(limits);
    if (!validId(operationId)) throw new Error('Invalid operation id');
    return this.withLock(() => {
      const entries = this.read(); const entry = this.find(entries, task);
      const now = Date.now(); this.checkClock(entry, now);
      if (entry.operations >= limits.maxOperations) throw new Error('Task budget exhausted: operations');
      if (entry.pendingOperationIds.includes(operationId)) throw new Error('Operation is already pending');
      entry.operations++; entry.pendingOperationIds.push(operationId); entry.lastWallMs = now;
      this.write(entries); return structuredClone(entry);
    });
  }
  /** Clear a pending operation only after an authoritative receipt or reconciliation settles it. */
  settleOperation(task: TaskSpec, operationId: string): Readonly<StoredTask> {
    return this.withLock(() => {
      const entries = this.read(); const entry = this.find(entries, task);
      entry.pendingOperationIds = entry.pendingOperationIds.filter(id => id !== operationId);
      // Reconciliation is not spending: never advance lastWallMs past the persisted deadline,
      // which would make a valid post-deadline settlement unreadable.
      this.write(entries); return structuredClone(entry);
    });
  }
  pendingOperations(task: TaskSpec): string[] {
    return this.withLock(() => [...this.find(this.read(), task).pendingOperationIds]);
  }
  private withLock<T>(fn: () => T): T {
    const release = acquireFileLock(`${this.path}.lock`);
    try { return fn(); } finally { release(); }
  }
  private find(entries: StoredTask[], task: TaskSpec): StoredTask {
    const entry = entries.find(e => e.taskId === task.taskId && e.revision === task.revision);
    if (!entry) throw new Error('Task not opened');
    if (entry.digest !== taskDigest(task)) throw new Error('Task content changed without a new revision');
    return entry;
  }
  private checkClock(entry: StoredTask, now: number): void {
    if (now < entry.lastWallMs) throw new Error('Task ledger clock moved backwards');
    if (now >= entry.deadlineWallMs) throw new Error('Task deadline exceeded');
  }
  private read(): StoredTask[] {
    if (!existsSync(this.path)) return [];
    const stat = lstatSync(this.path);
    if (stat.isSymbolicLink()) throw new Error('Task ledger cannot be a symbolic link');
    if (stat.size > MAX_BYTES) throw new Error('Task ledger is oversized');
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(this.path, 'utf8')); } catch { throw new Error('Invalid task ledger'); }
    if (!Array.isArray(parsed)) throw new Error('Invalid task ledger');
    const keys = new Set<string>();
    for (const value of parsed) {
      this.assertEntry(value);
      const key = JSON.stringify([value.taskId, value.revision]);
      if (keys.has(key)) throw new Error('Duplicate task ledger entry');
      keys.add(key);
      if (value.deadlineWallMs < value.lastWallMs) throw new Error('Invalid task ledger timestamps');
      if (value.pendingOperationIds === undefined) value.pendingOperationIds = [];
    }
    return parsed;
  }
  private assertEntry(value: unknown): asserts value is StoredTask {
    if (!record(value)) throw new Error('Invalid task ledger entry');
    if (Object.keys(value).some(key => !ENTRY_KEYS.has(key))) throw new Error('Invalid task ledger entry');
    if (typeof value.taskId !== 'string' || value.taskId.length === 0 || value.taskId.length > 256) throw new Error('Invalid task ledger entry');
    if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) throw new Error('Invalid task ledger entry');
    if (typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest)) throw new Error('Invalid task ledger entry');
    if (![value.deadlineWallMs, value.lastWallMs, value.operations, value.semanticRequests, value.expansions].every(natural)) throw new Error('Invalid task ledger entry');
    if (value.pendingOperationIds !== undefined) {
      if (!Array.isArray(value.pendingOperationIds) || value.pendingOperationIds.some(id => !validId(id))) throw new Error('Invalid task ledger entry');
      if (new Set(value.pendingOperationIds).size !== value.pendingOperationIds.length) throw new Error('Duplicate pending operation id');
    }
  }
  private write(entries: StoredTask[]): void {
    const dir = dirname(this.path); mkdirSync(dir, { recursive: true });
    const tmp = `${this.path}.${randomUUID()}.tmp`; let fd: number | undefined;
    try {
      fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      writeFileSync(fd, JSON.stringify(entries) + '\n'); fsyncSync(fd);
      closeSync(fd); fd = undefined;
      renameSync(tmp, this.path);
      const directory = openSync(dir, 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
    } catch (error) {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
      try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best-effort cleanup */ }
      throw error;
    }
  }
}
