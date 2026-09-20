import type { Binding, Observation, TaskSpec } from '../contracts.js';

export interface BindingRequest { task: TaskSpec; observation: Observation; signal: AbortSignal }
export interface BindingBatch {
  taskId: string; taskRevision: number; sessionEpoch: string; observationId: string;
  bindings: Binding[]; needMoreObservation: boolean; notFound: boolean;
}
export interface BindingProvider {
  readonly kind: 'deterministic' | 'semantic';
  /** Semantic execution must have fixture-specific calibration before being enabled. */
  readonly executionScope?: 'fixture' | 'profile';
  bind(request: BindingRequest): Promise<BindingBatch>;
}
export function ancestors(observation: Observation, targetRef: string): { ref: string; name: string; role: string }[] {
  const map = new Map(observation.nodes.map(n => [n.ref, n]));
  const result: { ref: string; name: string; role: string }[] = [];
  let node = map.get(targetRef);
  const seen = new Set<string>();
  while (node?.parentRef) {
    if (seen.has(node.parentRef)) throw new Error('Cyclic observation');
    seen.add(node.parentRef); node = map.get(node.parentRef);
    if (node) result.push({ ref: node.ref, name: node.name.status === 'available' ? node.name.value : '', role: node.role });
  }
  return result;
}
export function makeBinding(slotId: string, targetRef: string, observation: Observation, source: Binding['source']): Binding {
  return { slotId, targetRef, observationId: observation.observationId, source, evidence: [
    { observationId: observation.observationId, nodeRef: targetRef, field: 'name' },
    { observationId: observation.observationId, nodeRef: targetRef, field: 'role' },
    { observationId: observation.observationId, nodeRef: targetRef, field: 'parentRef' },
    ...ancestors(observation, targetRef).map(a => ({ observationId: observation.observationId, nodeRef: a.ref, field: 'name' as const })),
  ] };
}
/** Deterministic baseline: exact visible label plus exact requested region. */
export class ExactLabelProvider implements BindingProvider {
  readonly kind = 'deterministic';
  async bind({ task, observation, signal }: BindingRequest): Promise<BindingBatch> {
    signal.throwIfAborted();
    const bindings: Binding[] = [];
    for (const slot of task.slots) {
      const candidates = observation.nodes.filter(n => n.name.status === 'available' && n.name.value === slot.meaning && n.enabled.status === 'available' && n.enabled.value && n.capabilities.includes('set_value') && (!slot.regionHint || ancestors(observation, n.ref).some(a => a.name === slot.regionHint)));
      if (candidates.length === 1) bindings.push(makeBinding(slot.id, candidates[0]!.ref, observation, 'profile'));
    }
    const missing = bindings.length !== task.slots.length;
    return { taskId: task.taskId, taskRevision: task.revision, sessionEpoch: observation.sessionEpoch, observationId: observation.observationId, bindings, needMoreObservation: missing && observation.coverage.status === 'partial', notFound: missing && observation.coverage.status !== 'partial' };
  }
}
