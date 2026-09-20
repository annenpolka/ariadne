import { createHash, randomUUID } from 'node:crypto';
import type { Host, HostReceipt, Observation, ObservationQuery, PreparedOperation, PrepareRequest, ScopeGrant, Session, TaskSpec } from '../contracts.js';
import { HostError } from '../contracts.js';
import type { FakeFixture, FixtureSnapshot } from '../fixture.js';
import { validateContract } from '../validation.js';
import { DispatchJournal, taskKey } from './journal.js';
import type { JournalOperation, JournalState } from './journal.js';
export type Fault = 'journal_error' | 'after_intent' | 'after_dispatch' | 'response_lost';
export interface FakeHostOptions { fixture: FakeFixture; grant: ScopeGrant; journalPath: string; clock?: () => number; beforeDispatch?: () => Promise<void> }
interface StoredObservation { data: Observation; snapshot: FixtureSnapshot }
interface StoredPreparation { operation: PreparedOperation; snapshot: FixtureSnapshot; digest: string }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const id = (prefix: string) => `${prefix}-${randomUUID()}`;

function semanticContext(snapshot: FixtureSnapshot, ref: string): string {
  const nodes = new Map(snapshot.nodes.map(n => [n.ref, n])); const chain: unknown[] = []; const seen = new Set<string>();
  let current: string | null = ref;
  while (current) {
    if (seen.has(current)) throw new HostError('stale_binding', 'Cyclic element context');
    seen.add(current); const node = nodes.get(current); if (!node) return 'missing';
    chain.push({ ref: node.ref, parentRef: node.parentRef, role: node.role, name: node.name }); current = node.parentRef;
  }
  return JSON.stringify({ chain, appGeneration: snapshot.appGeneration, appId: snapshot.appId, windowRef: snapshot.windowRef, modalRef: snapshot.modalRef });
}

export class FakeHost implements Host {
  private readonly epoch = id('session');
  private control = 0;
  private grant: ScopeGrant;
  private readonly journal: DispatchJournal;
  private readonly clock: () => number;
  private task: TaskSpec | null = null;
  private deadline = 0;
  private cancelled = false;
  private closed = false;
  private fault: Fault | undefined;
  private observations = new Map<string, StoredObservation>();
  private preparations = new Map<string, StoredPreparation>();
  private byOperation = new Map<string, StoredPreparation>();
  private receipts = new Map<string, HostReceipt>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: FakeHostOptions) {
    this.options = { ...options }; this.grant = structuredClone(options.grant); this.validateGrant(this.grant);
    this.clock = options.clock ?? (() => Math.floor(performance.now()));
    this.journal = new DispatchJournal(options.journalPath);
    this.journal.transaction((_state, append) => append({ type: 'boot', epoch: this.epoch }));
  }
  setFault(fault: Fault | undefined): void { this.fault = fault; }
  updateGrant(grant: ScopeGrant): void {
    this.validateGrant(grant);
    if (grant.version <= this.grant.version) throw new HostError('invalid_request', 'Grant updates require a higher version');
    this.grant = structuredClone(grant); this.control++;
  }
  async openSession(input: TaskSpec): Promise<Session> {
    validateContract(input); const task = structuredClone(input);
    if (this.closed) throw new HostError('closed', 'Host closed');
    const snapshot = this.options.fixture.snapshot(); this.checkScope(snapshot, task);
    const sameTask = this.task?.taskId === task.taskId && this.task.revision === task.revision;
    if (sameTask && digest(this.task) !== digest(task)) throw new HostError('invalid_request', 'Task changed without a new revision');
    const stored = this.journal.transaction((state, append) => {
      this.checkEpoch(state);
      const key = taskKey(task.taskId, task.revision); const prior = state.tasks.get(key); const hash = digest(task);
      if (prior && prior.digest !== hash) throw new HostError('invalid_request', 'Persisted task changed without a new revision');
      if (prior && Date.now() < prior.lastWallMs) throw new HostError('invalid_request', 'Clock moved backwards');
      const deadlineWallMs = Math.min(prior?.deadlineWallMs ?? Infinity, Date.now() + Math.min(task.budgets.deadlineMs, this.grant.limits.deadlineMs));
      append({ type: 'task', taskId: task.taskId, revision: task.revision, digest: hash, deadlineWallMs, lastWallMs: Date.now() });
      return state.tasks.get(key)!;
    });
    if (!sameTask || this.cancelled) { this.control++; this.observations.clear(); this.cancelled = false; }
    this.task = task; this.deadline = Math.min(sameTask ? this.deadline : Infinity, this.clock() + Math.max(0, stored.deadlineWallMs - Date.now()));
    const unresolvedOperationIds = this.journal.transaction(state => [...state.operations].filter(([, op]) => op.scopeRef === task.scopeRef && ['dispatch_intent', 'outcome_unknown'].includes(op.receipt.status)).map(([key]) => key));
    return { sessionEpoch: this.epoch, controlEpoch: this.control, scopeRef: this.grant.scopeRef, grantRef: this.grant.grantRef, grantVersion: this.grant.version, unresolvedOperationIds };
  }
  async capture(query: ObservationQuery = 'editable_fields'): Promise<Observation> {
    this.active();
    if (!['window_summary', 'active_dialog', 'editable_fields', 'element_context', 'changes_since'].includes(query)) throw new HostError('invalid_request', 'Unknown observation query');
    const started = this.clock(); const snapshot = this.options.fixture.snapshot(); this.checkScope(snapshot, this.task!);
    this.journal.transaction(state => this.checkEpoch(state));
    const data: Observation = { kind: 'observation', schemaVersion: '0.1', observationId: id('obs'), sessionEpoch: this.epoch, scopeRef: this.grant.scopeRef, capture: { startedMonoMs: started, endedMonoMs: this.clock(), eventSeqBefore: snapshot.eventSeq, eventSeqAfter: snapshot.eventSeq, consistency: 'atomic' }, coverage: { rootRef: snapshot.windowRef, status: 'provider_exhausted', omittedReasons: [], nodeCount: snapshot.nodes.length }, nodes: snapshot.nodes };
    validateContract(data); this.observations.set(data.observationId, { data: structuredClone(data), snapshot });
    if (this.observations.size > 128) this.observations.delete(this.observations.keys().next().value!);
    return structuredClone(data);
  }
  async prepare(input: PrepareRequest): Promise<PreparedOperation> {
    this.active(); const request = structuredClone(input); const snapshot = this.options.fixture.snapshot(); this.checkScope(snapshot, this.task!); this.checkAct();
    if (!request || typeof request.operationId !== 'string' || request.taskId !== this.task!.taskId || request.taskRevision !== this.task!.revision || request.sessionEpoch !== this.epoch) throw new HostError('stale_session', 'Prepare task/session mismatch');
    const origin = this.observations.get(request.binding?.observationId);
    if (!origin || !origin.data.nodes.some(n => n.ref === request.binding.targetRef) || request.command?.targetRef !== request.binding.targetRef) throw new HostError('stale_binding', 'Unknown observation or bound target');
    const slot = this.task!.slots.find(s => s.id === request.binding.slotId);
    if (!slot || request.command.kind !== 'set_value' || request.command.value !== this.task!.inputs[slot.inputRef]) throw new HostError('invalid_request', 'fill-fields operation must use its fixed slot input');
    if (!request.binding.evidence?.length || request.binding.evidence.some(e => e.observationId !== origin.data.observationId || !origin.data.nodes.some(n => n.ref === e.nodeRef))) throw new HostError('stale_binding', 'Binding evidence is outside its observation');
    if (semanticContext(origin.snapshot, request.binding.targetRef) !== semanticContext(snapshot, request.binding.targetRef)) throw new HostError('stale_binding', 'Binding context changed');
    const node = snapshot.nodes.find(n => n.ref === request.binding.targetRef)!;
    if (!node.capabilities.includes(request.command.kind) || !this.grant.allowedCommands.includes(request.command.kind) || node.enabled.status !== 'available' || !node.enabled.value || node.value.status !== 'available') throw new HostError('unsupported', 'Target cannot be guarded and changed');
    if (snapshot.focusedWindowRef !== this.grant.windowRef || snapshot.modalRef !== null) throw new HostError('stale_binding', 'Focus or modal changed');
    const hash = digest(request); const prior = this.byOperation.get(request.operationId);
    if (prior) { if (prior.digest !== hash) throw new HostError('invalid_request', 'Operation ID reused with different content'); return structuredClone(prior.operation); }
    this.journal.transaction(state => {
      this.checkEpoch(state); this.checkUnresolved(state, this.grant.scopeRef);
      if (state.operations.has(request.operationId)) throw new HostError('invalid_request', 'Operation ID already recorded; use status');
      this.checkBudget(state);
    });
    const operation: PreparedOperation = { kind: 'prepared_operation', schemaVersion: '0.1', ...request, preparedId: id('prepared'), controlEpoch: this.control, scopeRef: this.grant.scopeRef, grantRef: this.grant.grantRef, grantVersion: this.grant.version, originObservationId: request.binding.observationId, guardSetRef: id('guards'), expiresAtMonoMs: Math.min(this.deadline, this.clock() + 10_000) };
    validateContract(operation);
    const prepared = { operation: structuredClone(operation), snapshot, digest: hash };
    this.preparations.set(operation.preparedId, prepared); this.byOperation.set(operation.operationId, prepared); return structuredClone(operation);
  }
  async commit(preparedId: string): Promise<HostReceipt> {
    const prepared = this.preparations.get(preparedId);
    if (!prepared) throw new HostError('stale_session', 'Unknown prepared ID');
    const run = this.queue.then(() => this.dispatch(prepared)); this.queue = run.catch(() => {}); return run;
  }
  private async dispatch(prepared: StoredPreparation): Promise<HostReceipt> {
    const op = prepared.operation;
    const known = this.receipts.get(op.operationId); if (known) return structuredClone(known);
    const firstGuard = this.preflight(prepared); if (firstGuard) return this.remember(firstGuard);
    if (this.options.beforeDispatch) await this.options.beforeDispatch();
    const guard = this.preflight(prepared); if (guard) return this.remember(guard);
    let entered = false; let result: HostReceipt;
    try {
      result = this.journal.transaction((state, append) => {
        this.checkEpoch(state);
        const existing = state.operations.get(op.operationId); if (existing) return this.recovered(existing);
        this.checkUnresolved(state, op.scopeRef); this.checkBudget(state);
        const finalGuard = this.preflight(prepared); if (finalGuard) return finalGuard;
        if (this.fault === 'journal_error') throw new HostError('journal_error', 'Injected intent persistence failure');
        append({ type: 'intent', taskId: op.taskId, taskRevision: op.taskRevision, scopeRef: op.scopeRef, operationId: op.operationId, requestDigest: prepared.digest, receipt: this.receipt(op.operationId, 'dispatch_intent', 'none') });
        entered = true;
        if (this.fault === 'after_intent') return this.receipt(op.operationId, 'outcome_unknown', 'host_lost');
        try { this.options.fixture.dispatch(structuredClone(op.command)); }
        catch { const unknown = this.receipt(op.operationId, 'outcome_unknown', 'driver_error'); append({ type: 'receipt', operationId: op.operationId, receipt: unknown }); return unknown; }
        if (this.fault === 'after_dispatch') return this.receipt(op.operationId, 'outcome_unknown', 'host_lost');
        const attempted = this.receipt(op.operationId, 'attempted', 'none'); append({ type: 'receipt', operationId: op.operationId, receipt: attempted }); return attempted;
      });
    } catch (error) {
      if (error instanceof HostError && error.code === 'outcome_unknown') result = this.receipt(op.operationId, 'outcome_unknown', 'host_lost');
      else result = this.receipt(op.operationId, entered ? 'outcome_unknown' : 'not_dispatched', error instanceof HostError && error.code === 'stale_session' ? 'precondition_changed' : 'journal_error');
    }
    this.remember(result);
    if (this.fault === 'response_lost' && result.status === 'attempted') throw new HostError('outcome_unknown', 'Injected response loss; query operation.status');
    return structuredClone(result);
  }
  async status(operationId: string): Promise<HostReceipt | null> {
    const known = this.receipts.get(operationId); if (known) return structuredClone(known);
    return this.journal.transaction(state => { const operation = state.operations.get(operationId); return operation ? this.recovered(operation) : null; });
  }
  async cancel(): Promise<void> { this.cancelled = true; this.control++; }
  async close(): Promise<void> { this.closed = true; this.control++; this.observations.clear(); }
  private active(): void {
    if (this.closed) throw new HostError('closed', 'Host closed');
    if (!this.task) throw new HostError('closed', 'No open session');
    if (this.cancelled) throw new HostError('cancelled', 'Session cancelled; explicit openSession required');
  }
  private preflight(prepared: StoredPreparation): HostReceipt | null {
    const op = prepared.operation;
    if (this.cancelled || this.closed || op.controlEpoch !== this.control || op.taskId !== this.task?.taskId || op.taskRevision !== this.task?.revision) return this.receipt(op.operationId, 'not_dispatched', this.cancelled ? 'cancelled_before_dispatch' : 'precondition_changed');
    if (this.clock() >= op.expiresAtMonoMs) return this.receipt(op.operationId, 'expired', 'expired');
    const snapshot = this.options.fixture.snapshot();
    if (!this.grant.act || !this.grant.read || this.grant.version !== op.grantVersion || this.grant.grantRef !== op.grantRef || this.grant.scopeRef !== op.scopeRef || !this.grant.allowedCommands.includes(op.command.kind)) return this.receipt(op.operationId, 'not_dispatched', 'scope_denied');
    const node = snapshot.nodes.find(n => n.ref === op.command.targetRef); const before = prepared.snapshot.nodes.find(n => n.ref === op.command.targetRef);
    if (!node || !before || semanticContext(snapshot, node.ref) !== semanticContext(prepared.snapshot, node.ref) || snapshot.focusedWindowRef !== prepared.snapshot.focusedWindowRef || node.enabled.status !== 'available' || !node.enabled.value || !node.capabilities.includes(op.command.kind) || JSON.stringify(node.value) !== JSON.stringify(before.value)) return this.receipt(op.operationId, 'not_dispatched', 'precondition_changed');
    return null;
  }
  private checkScope(snapshot: FixtureSnapshot, task: TaskSpec): void { if (!this.grant.read || task.scopeRef !== this.grant.scopeRef || snapshot.appId !== this.grant.appId || snapshot.windowRef !== this.grant.windowRef) throw new HostError('scope_denied', 'Scope is not granted'); }
  private checkAct(): void { if (!this.grant.act) throw new HostError('scope_denied', 'Act is not granted'); }
  private checkEpoch(state: JournalState): void { if (state.epoch !== this.epoch) throw new HostError('stale_session', 'Another host replaced this session'); }
  private checkUnresolved(state: JournalState, scopeRef: string): void { if ([...state.operations.values()].some(o => o.scopeRef === scopeRef && ['dispatch_intent', 'outcome_unknown'].includes(o.receipt.status))) throw new HostError('outcome_unknown', 'Scope has an unresolved operation'); }
  private checkBudget(state: JournalState): void {
    const task = this.task!; const stored = state.tasks.get(taskKey(task.taskId, task.revision));
    if (!stored || Date.now() < stored.lastWallMs || Date.now() >= stored.deadlineWallMs || this.clock() >= this.deadline || stored.operations >= Math.min(task.budgets.maxOperations, this.grant.limits.maxOperations)) throw new HostError('invalid_request', 'Task deadline or operation budget exhausted');
  }
  private recovered(operation: JournalOperation): HostReceipt { const result = structuredClone(operation.receipt); if (result.status === 'dispatch_intent') { result.status = 'outcome_unknown'; result.reason = 'host_lost'; } return result; }
  private receipt(operationId: string, status: HostReceipt['status'], reason: HostReceipt['reason']): HostReceipt { return { kind: 'host_receipt', schemaVersion: '0.1', operationId, sessionEpoch: this.epoch, eventSeq: this.options.fixture.snapshot().eventSeq, status, reason }; }
  private remember(receipt: HostReceipt): HostReceipt { this.receipts.set(receipt.operationId, structuredClone(receipt)); return structuredClone(receipt); }
  private validateGrant(grant: ScopeGrant): void {
    if (!grant || !Number.isSafeInteger(grant.version) || grant.version < 1 || !['scopeRef', 'grantRef', 'appId', 'windowRef'].every(k => typeof grant[k as keyof ScopeGrant] === 'string' && (grant[k as keyof ScopeGrant] as string).length > 0) || !['read', 'model', 'act'].every(k => typeof grant[k as keyof ScopeGrant] === 'boolean') || !Array.isArray(grant.allowedCommands) || grant.allowedCommands.some(c => c !== 'set_value' && c !== 'invoke') || !grant.limits || !['maxOperations', 'maxSemanticRequests', 'maxObservationExpansions', 'deadlineMs'].every(k => Number.isSafeInteger(grant.limits[k as keyof typeof grant.limits]) && grant.limits[k as keyof typeof grant.limits] >= 0)) throw new HostError('invalid_request', 'Invalid operator grant');
  }
}
