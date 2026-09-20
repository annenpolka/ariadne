import { randomUUID } from 'node:crypto';
import type { Binding, Budgets, Host, HostReceipt, Observation, ScopeGrant, TaskResult, TaskSpec } from '../contracts.js';
import { HostError } from '../contracts.js';
import { validateContract, validateResultForTask } from '../validation.js';
import type { BindingProvider } from '../providers/binding.js';
import { TaskLedger, validateLimits } from './task-ledger.js';

export interface Handoff { reason: string; observedScope: string | null; missingSlots: string[]; unresolvedOperationIds: string[]; remaining: Budgets }
export interface RunOutcome { result: TaskResult; handoff: Handoff | null; trace: { state: string; elapsedMs: number }[] }
export interface RunOptions { mode?: 'preview' | 'execute'; signal?: AbortSignal }
export interface RuntimeOptions { host: Host; provider: BindingProvider; grant: ScopeGrant; statePath: string; environment: 'fixture_atomic' | 'external_best_effort'; bindingMode?: 'batch' | 'each_step' }

/** A completed dispatch whose deterministic readback failed; distinct from a blocked precondition. */
class VerificationError extends Error { constructor(message: string) { super(message); this.name = 'VerificationError'; } }
const MAX_TIMEOUT_MS = 0x7fffffff;

function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason ?? new Error('Cancelled')); };
    // Attach both handlers even if already aborted; late rejection must not be unhandled.
    work.then(value => { signal.removeEventListener('abort', abort); if (!signal.aborted) resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}
/**
 * Semantic dependency of a bound target: the full observed ancestor chain with refs, roles and
 * name status. refs are included so a same-label replacement higher up cannot be hidden.
 */
function context(observation: Observation, ref: string): string {
  const nodes = new Map(observation.nodes.map(n => [n.ref, n]));
  const chain: unknown[] = []; const seen = new Set<string>();
  let current: string | null = ref;
  while (current !== null) {
    if (seen.has(current)) { chain.push({ ref: current, cycle: true }); break; }
    seen.add(current);
    const node = nodes.get(current);
    if (!node) { chain.push({ ref: current, missing: true }); break; }
    chain.push({ ref: node.ref, role: node.role, parentRef: node.parentRef, name: node.name.status === 'available' ? { status: 'available', value: node.name.value } : { status: node.name.status } });
    current = node.parentRef;
  }
  return JSON.stringify(chain);
}

export class AriadneRuntime {
  private running = false;
  constructor(private readonly options: RuntimeOptions) {}
  async run(input: TaskSpec, options: RunOptions = {}): Promise<RunOutcome> {
    if (this.running) throw new Error('Only one Task may run at a time');
    validateContract(input); const task = structuredClone(input); const grant = structuredClone(this.options.grant);
    this.running = true;
    const start = performance.now();
    const trace: RunOutcome['trace'] = [];
    const transition = (state: string) => trace.push({ state, elapsedMs: Math.floor(performance.now() - start) });
    const result: TaskResult = { kind: 'task_result', schemaVersion: '0.1', taskId: task.taskId, taskRevision: task.revision, status: 'blocked', requiredCheckIds: task.requiredChecks.map(c => c.id), checks: [], unresolvedOperationIds: [], assurance: { targetBinding: this.options.provider.kind === 'semantic' ? 'semantic' : 'profile', effectCheck: 'unavailable', environment: this.options.environment } };
    const remaining: Budgets = { maxOperations: 0, maxSemanticRequests: 0, maxObservationExpansions: 0, deadlineMs: 0 };
    let reason = 'not_started'; let timer: ReturnType<typeof setTimeout> | undefined; let lease: { release(): void } | undefined;
    let ownsLease = false; let finished = false; let cleanupError: string | undefined;
    let observation: Observation | null = null; let bindings: Binding[] = []; let originalContexts = new Map<string, string>();
    let pendingOperation: string | null = null; let dispatchedOperation: string | null = null; let effectiveDeadlineMs = 0;
    const failureCounts = new Map<string, number>();
    const control = new AbortController(); const signal = control.signal;
    // Never touch the Host before this run owns the whole-run lease; guard against late callbacks.
    const abortRun = (error: Error) => { if (finished || signal.aborted) return; control.abort(error); if (ownsLease) void this.options.host.cancel().catch(() => {}); };
    const onExternalAbort = () => abortRun(new HostError('cancelled', 'Cancelled'));
    const call = <T>(work: Promise<T>) => bounded(work, signal);
    const ledger = new TaskLedger(this.options.statePath);
    try {
      if (!grant.read || grant.scopeRef !== task.scopeRef) throw new HostError('scope_denied', 'Read scope not granted');
      validateLimits(task.budgets); validateLimits(grant.limits);
      const limits: Budgets = { maxOperations: Math.min(task.budgets.maxOperations, grant.limits.maxOperations), maxSemanticRequests: Math.min(task.budgets.maxSemanticRequests, grant.limits.maxSemanticRequests), maxObservationExpansions: Math.min(task.budgets.maxObservationExpansions, grant.limits.maxObservationExpansions), deadlineMs: Math.min(task.budgets.deadlineMs, grant.limits.deadlineMs) };
      lease = ledger.acquireLease(task); ownsLease = true;
      const stored = ledger.open(task, limits);
      remaining.maxOperations = Math.max(0, limits.maxOperations - stored.operations);
      remaining.maxSemanticRequests = Math.max(0, limits.maxSemanticRequests - stored.semanticRequests);
      remaining.maxObservationExpansions = Math.max(0, limits.maxObservationExpansions - stored.expansions);
      const now = Date.now();
      if (now < stored.lastWallMs) throw new HostError('invalid_request', 'Clock moved backwards');
      const persistedRemaining = stored.deadlineWallMs - now;
      if (persistedRemaining <= 0) throw new Error('Task deadline exceeded');
      effectiveDeadlineMs = Math.min(limits.deadlineMs, persistedRemaining, MAX_TIMEOUT_MS);
      if (options.signal?.aborted) onExternalAbort(); else options.signal?.addEventListener('abort', onExternalAbort, { once: true });
      timer = setTimeout(() => abortRun(new Error('Task deadline exceeded')), effectiveDeadlineMs);
      signal.throwIfAborted();
      transition('opening');
      const session = await call(this.options.host.openSession(task));
      const captureOnce = async (expanded: boolean) => {
        const obs = await call(this.options.host.capture(expanded ? 'window_summary' : 'editable_fields'));
        validateContract(obs);
        if (obs.sessionEpoch !== session.sessionEpoch || obs.scopeRef !== task.scopeRef) throw new HostError('stale_session', 'Observation belongs to another session');
        if (obs.capture.eventSeqBefore !== obs.capture.eventSeqAfter) throw new HostError('stale_binding', 'Observation changed during capture');
        observation = obs; return obs;
      };
      // A dirty capture may be retried a bounded number of times while no effect outcome is unknown.
      const capture = async (expanded = false) => {
        if (expanded) {
          if (remaining.maxObservationExpansions <= 0) throw new HostError('unsupported', 'Observation expansion budget exhausted');
          ledger.spend(task, 'expansions', limits); remaining.maxObservationExpansions--;
        }
        let lastError: unknown;
        for (let attempt = 0; attempt < 3; attempt++) {
          try { return await captureOnce(expanded); }
          catch (error) {
            if (error instanceof HostError && error.code === 'stale_binding' && !pendingOperation) { lastError = error; continue; }
            throw error;
          }
        }
        throw lastError;
      };
      const choose = async () => {
        const obs = observation!;
        if (this.options.provider.kind === 'semantic') {
          if (!grant.model) throw new HostError('scope_denied', 'Model transfer is not granted');
          if (options.mode !== 'preview' && (this.options.provider.executionScope === undefined || (this.options.provider.executionScope === 'fixture' && grant.appId !== 'ariadne.fixture'))) throw new HostError('scope_denied', 'Semantic execution has no calibrated scope');
          if (remaining.maxSemanticRequests <= 0) throw new HostError('unsupported', 'Semantic budget exhausted');
          ledger.spend(task, 'semanticRequests', limits); remaining.maxSemanticRequests--;
        }
        transition('binding');
        const batch = await call(this.options.provider.bind({ task: structuredClone(task), observation: structuredClone(obs), signal }));
        if (batch.taskId !== task.taskId || batch.taskRevision !== task.revision || batch.sessionEpoch !== session.sessionEpoch || batch.observationId !== obs.observationId) throw new HostError('invalid_request', 'Late or foreign provider answer');
        const slotIds = new Set(task.slots.map(s => s.id)); const targets = new Set<string>(); const boundSlots = new Set<string>();
        for (const b of batch.bindings) {
          if (!slotIds.has(b.slotId) || boundSlots.has(b.slotId) || targets.has(b.targetRef) || b.observationId !== obs.observationId || !obs.nodes.some(n => n.ref === b.targetRef) || !b.evidence.length || b.evidence.some(e => e.observationId !== obs.observationId || !obs.nodes.some(n => n.ref === e.nodeRef))) throw new HostError('invalid_request', 'Invalid binding set');
          boundSlots.add(b.slotId); targets.add(b.targetRef);
        }
        bindings = structuredClone(batch.bindings); return batch;
      };
      // A resumed receipt may carry the previous Host epoch; identity + terminal status settle it.
      const settlesResume = (receipt: HostReceipt | null, operationId: string): boolean => {
        if (!receipt) return false;
        try { validateContract(receipt); } catch { return false; }
        return receipt.kind === 'host_receipt' && receipt.operationId === operationId && (receipt.status === 'attempted' || receipt.status === 'not_dispatched' || receipt.status === 'expired');
      };
      // A prior unresolved effect fences all mutation until an authoritative status settles it.
      const unresolved = new Set<string>(session.unresolvedOperationIds ?? []);
      for (const operationId of stored.pendingOperationIds) unresolved.add(operationId);
      if (unresolved.size > 0) {
        const stillUnresolved: string[] = [];
        for (const operationId of unresolved) {
          let receipt: HostReceipt | null = null;
          try { receipt = await call(this.options.host.status(operationId)); } catch { receipt = null; }
          if (settlesResume(receipt, operationId)) {
            try { ledger.settleOperation(task, operationId); } catch { stillUnresolved.push(operationId); }
          } else stillUnresolved.push(operationId);
        }
        if (stillUnresolved.length > 0) {
          result.status = 'outcome_unknown'; result.unresolvedOperationIds = stillUnresolved;
          reason = 'Unresolved operation requires reconciliation before further changes';
          transition('outcome_unknown');
          throw new HostError('outcome_unknown', reason);
        }
      }
      transition('observing'); await capture();
      let batch = await choose();
      while (batch.needMoreObservation && bindings.length !== task.slots.length) { await capture(true); batch = await choose(); }
      if (bindings.length !== task.slots.length || batch.notFound) throw new HostError('unsupported', 'Input fields could not be uniquely bound in the observed scope');
      originalContexts = new Map(bindings.map(b => [b.slotId, context(observation!, b.targetRef)]));
      if (options.mode === 'preview') { result.status = 'completed_unverified'; reason = 'preview_ready'; transition('preview_ready'); }
      else {
        if (!grant.act) throw new HostError('scope_denied', 'Act grant is missing');
        const attemptSlot = async (slot: TaskSpec['slots'][number]) => {
          const binding = bindings.find(b => b.slotId === slot.id);
          if (!binding) throw new HostError('stale_binding', `No binding for slot ${slot.id}`);
          const current = await capture();
          if (context(current, binding.targetRef) !== originalContexts.get(slot.id)) throw new HostError('stale_binding', `Bound target changed before prepare (${slot.id})`);
          const node = current.nodes.find(n => n.ref === binding.targetRef)!;
          if (node.value.status !== 'available') throw new HostError('unsupported', 'Cannot guard an unavailable input value');
          if (node.value.value === task.inputs[slot.inputRef]) return;
          const fresh: Binding = { ...binding, observationId: current.observationId, evidence: binding.evidence.map(e => ({ ...e, observationId: current.observationId })) };
          const operationId = `op-${randomUUID()}`;
          transition('preparing');
          const operation = await call(this.options.host.prepare({ operationId, taskId: task.taskId, taskRevision: task.revision, sessionEpoch: session.sessionEpoch, binding: fresh, command: { kind: 'set_value', targetRef: binding.targetRef, value: task.inputs[slot.inputRef]! } }));
          validateContract(operation);
          if (operation.operationId !== operationId || operation.taskId !== task.taskId || operation.taskRevision !== task.revision || operation.sessionEpoch !== session.sessionEpoch || operation.scopeRef !== task.scopeRef || operation.command.kind !== 'set_value' || operation.command.targetRef !== binding.targetRef || operation.command.value !== task.inputs[slot.inputRef]) throw new HostError('invalid_request', 'Host prepared different operation');
          if (remaining.maxOperations <= 0) throw new HostError('unsupported', 'Operation budget exhausted');
          ledger.beginOperation(task, operationId, limits); remaining.maxOperations--;
          pendingOperation = operationId; transition('dispatching');
          let receipt;
          try { receipt = await call(this.options.host.commit(operation.preparedId)); }
          catch (error) {
            if (signal.aborted) throw error;
            receipt = await call(this.options.host.status(operationId));
            if (!receipt) throw error;
          }
          validateContract(receipt);
          if (receipt.operationId !== operationId || receipt.sessionEpoch !== session.sessionEpoch) throw new HostError('invalid_request', 'Host receipt identity mismatch');
          if (receipt.status === 'outcome_unknown' || receipt.status === 'dispatch_intent') throw new HostError('outcome_unknown', 'Operation outcome is unknown');
          if (receipt.status === 'not_dispatched' || receipt.status === 'expired') {
            // Durable settlement must not be swallowed; an error keeps the operation fenced.
            ledger.settleOperation(task, operationId);
            pendingOperation = null;
            if (receipt.reason === 'precondition_changed') throw new HostError('stale_binding', `Precondition changed before dispatch: ${receipt.reason}`);
            if (receipt.reason === 'cancelled_before_dispatch' || signal.aborted) throw new HostError('cancelled', 'Cancelled before dispatch');
            if (receipt.status === 'expired') throw new HostError('unsupported', 'Prepared operation expired');
            throw new HostError('unsupported', `Operation not dispatched: ${receipt.reason}`);
          }
          if (receipt.status !== 'attempted') throw new HostError('invalid_request', `Unexpected receipt status: ${receipt.status}`);
          pendingOperation = null; dispatchedOperation = operationId;
          transition('readback'); const after = await capture();
          const actual = after.nodes.find(n => n.ref === binding.targetRef);
          if (context(after, binding.targetRef) !== originalContexts.get(slot.id)) throw new VerificationError('Readback target context changed');
          if (actual?.value.status !== 'available' || actual.value.value !== task.inputs[slot.inputRef]) throw new VerificationError('Readback did not verify target and value');
          // Attempted is an effect receipt, not success: durable settlement must succeed before clearing.
          ledger.settleOperation(task, operationId);
          dispatchedOperation = null;
        };
        const recover = async (error: unknown, slotId: string) => {
          if (pendingOperation || dispatchedOperation) throw error; // never retry once an effect might have happened
          if (!(error instanceof HostError && error.code === 'stale_binding')) throw error;
          const fingerprint = `stale_binding:${slotId}`;
          const seen = failureCounts.get(fingerprint) ?? 0; failureCounts.set(fingerprint, seen + 1);
          if (seen >= 1) throw new HostError('unsupported', `Repeated failure fingerprint ${fingerprint}`);
          if (remaining.maxObservationExpansions <= 0) throw new HostError('unsupported', 'Observation expansion budget exhausted');
          transition('recovering'); await capture(true);
          const batch = await choose();
          if (bindings.length !== task.slots.length || batch.notFound) throw new HostError('unsupported', 'Input fields could not be uniquely bound during recovery');
          originalContexts = new Map(bindings.map(b => [b.slotId, context(observation!, b.targetRef)]));
        };
        for (const [index, slot] of task.slots.entries()) {
          signal.throwIfAborted();
          if (this.options.bindingMode === 'each_step' && index > 0) {
            await capture(); const batch = await choose();
            if (bindings.length !== task.slots.length || batch.notFound) throw new HostError('unsupported', 'Could not bind the next step');
            originalContexts = new Map(bindings.map(b => [b.slotId, context(observation!, b.targetRef)]));
          }
          for (;;) { try { await attemptSlot(slot); break; } catch (error) { await recover(error, slot.id); } }
        }
        transition('verifying'); const final = await capture();
        result.checks = task.requiredChecks.map(check => {
          const b = bindings.find(b => b.slotId === check.slotId)!; const node = final.nodes.find(n => n.ref === b.targetRef);
          const passed = context(final, b.targetRef) === originalContexts.get(check.slotId) && node?.value.status === 'available' && node.value.value === task.inputs[check.inputRef];
          return { checkId: check.id, status: passed ? 'pass' : 'fail', method: 'exact_readback', evidence: [{ observationId: final.observationId, nodeRef: b.targetRef, field: 'value' }, { observationId: final.observationId, nodeRef: b.targetRef, field: 'parentRef' }] };
        });
        result.assurance.effectCheck = 'deterministic';
        if (result.checks.every(c => c.status === 'pass')) {
          // Re-read on resume is done; success additionally requires no durable pending operation.
          const pendingNow = ledger.pendingOperations(task);
          if (pendingNow.length > 0) { result.unresolvedOperationIds = pendingNow; throw new HostError('outcome_unknown', 'Durable pending operations remain unsettled'); }
          result.status = 'verified_success';
        } else result.status = 'failed';
        reason = result.status; transition(result.status);
      }
    } catch (error) {
      reason = error instanceof Error ? error.message : 'Unknown runtime error';
      if (error instanceof VerificationError) result.status = 'failed';
      else if (pendingOperation || dispatchedOperation) { result.status = 'outcome_unknown'; const id = pendingOperation ?? dispatchedOperation!; if (!result.unresolvedOperationIds.includes(id)) result.unresolvedOperationIds.push(id); }
      else if (error instanceof HostError && error.code === 'outcome_unknown') result.status = 'outcome_unknown';
      else if (options.signal?.aborted) result.status = 'cancelled';
      else result.status = 'blocked';
      transition(result.status);
    } finally {
      finished = true;
      if (timer) clearTimeout(timer); options.signal?.removeEventListener('abort', onExternalAbort);
      try { lease?.release(); ownsLease = false; } catch (error) { cleanupError = error instanceof Error ? error.message : 'lease cleanup failed'; }
      this.running = false;
    }
    if (cleanupError) {
      reason = reason ? `${reason}; cleanup failed: ${cleanupError}` : `cleanup failed: ${cleanupError}`;
      if (result.status === 'verified_success') { result.status = 'blocked'; transition('blocked'); }
    }
    remaining.deadlineMs = effectiveDeadlineMs > 0 ? Math.max(0, Math.floor(effectiveDeadlineMs - (performance.now() - start))) : Math.max(0, Math.floor(remaining.deadlineMs));
    validateResultForTask(result, task);
    const observed = observation as Observation | null;
    return { result, trace, handoff: result.status === 'verified_success' ? null : { reason, observedScope: observed?.coverage.rootRef ?? null, missingSlots: task.slots.filter(s => !bindings.some(b => b.slotId === s.id)).map(s => s.id), unresolvedOperationIds: [...result.unresolvedOperationIds], remaining } };
  }
}
