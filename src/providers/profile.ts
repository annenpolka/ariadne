import { makeBinding, type BindingBatch, type BindingProvider, type BindingRequest } from './binding.js';
import { HostError } from '../contracts.js';

/** TextEdit's one document body; Host separately verifies the operator-selected file/window. */
export class TextEditBodyProvider implements BindingProvider {
  readonly kind = 'deterministic';
  async bind({ task, observation, signal }: BindingRequest): Promise<BindingBatch> {
    signal.throwIfAborted();
    if (task.slots.length !== 1) throw new Error('TextEdit body profile requires exactly one slot');
    const candidates = observation.nodes.filter(n => n.role === 'text_area' && n.enabled.status === 'available' && n.enabled.value && n.capabilities.includes('set_value'));
    if (candidates.length === 0 && observation.coverage.status === 'provider_exhausted') throw new HostError('unsupported', 'TextEdit body lacks a confirmed enabled state or direct value-setting capability');
    const bindings = candidates.length === 1 ? [makeBinding(task.slots[0]!.id, candidates[0]!.ref, observation, 'profile')] : [];
    return { taskId: task.taskId, taskRevision: task.revision, sessionEpoch: observation.sessionEpoch, observationId: observation.observationId, bindings, needMoreObservation: bindings.length === 0 && observation.coverage.status === 'partial', notFound: bindings.length === 0 && observation.coverage.status !== 'partial' };
  }
}
