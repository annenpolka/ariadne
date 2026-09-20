import { Ajv2020 } from 'ajv/dist/2020.js';
import schema from '../contracts.schema.json' with { type: 'json' };
import type { Contract, TaskSpec, TaskResult } from './contracts.js';

const ajv = new Ajv2020({ allErrors: true, strict: false, strictNumbers: true });
const check = ajv.compile(schema);
function require(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid contract: ${message}`);
}
export function validateContract(value: unknown): asserts value is Contract {
  if (!check(value)) throw new Error(`Invalid contract: ${ajv.errorsText(check.errors)}`);
  const data = value as Contract;
  switch (data.kind) {
    case 'browser_action_task': {
      require(new Set(data.steps.map(s => s.id)).size === data.steps.length, 'duplicate action steps');
      require(new Set(data.requiredChecks.map(c => c.id)).size === data.requiredChecks.length, 'duplicate action checks');
      for (const step of data.steps) if (step.kind === 'set_value') require(Object.hasOwn(data.inputs, step.inputRef), 'unknown action input');
      break;
    }
    case 'task': {
      const slots = new Map(data.slots.map(s => [s.id, s]));
      require(slots.size === data.slots.length, 'duplicate slot ids');
      require(new Set(data.requiredChecks.map(c => c.id)).size === data.requiredChecks.length, 'duplicate check ids');
      require(data.requiredChecks.length === slots.size, 'one check per slot required');
      require(new Set(data.requiredChecks.map(c => c.slotId)).size === slots.size, 'duplicate checked slots');
      for (const slot of data.slots) require(Object.hasOwn(data.inputs, slot.inputRef), 'unknown inputRef');
      for (const c of data.requiredChecks) require(slots.get(c.slotId)?.inputRef === c.inputRef, 'check input does not match slot');
      break;
    }
    case 'observation': {
      if (data.document) {
        require(data.document.sessionEpoch === data.sessionEpoch, 'document epoch mismatch');
        require(data.nodes.every(node => node.capabilities.length === 0), 'read observation exposes capabilities');
        for (const node of data.nodes) for (const attr of [node.name, node.value, node.enabled]) {
          if (attr.status === 'error' || attr.status === 'redacted') require(data.coverage.status === 'partial' && data.coverage.omittedReasons.includes(attr.status), 'read observation hides omitted attributes');
        }
      }
      require(data.capture.endedMonoMs >= data.capture.startedMonoMs, 'capture time reversed');
      require(data.capture.eventSeqAfter >= data.capture.eventSeqBefore, 'event sequence reversed');
      const nodes = new Map(data.nodes.map(n => [n.ref, n]));
      require(nodes.size === data.nodes.length, 'duplicate node refs');
      require(nodes.has(data.coverage.rootRef), 'coverage root missing');
      require(data.coverage.nodeCount === data.nodes.length, 'node count mismatch');
      require((data.coverage.status === 'partial') === (data.coverage.omittedReasons.length > 0), 'coverage omissions inconsistent');
      const connected = new Set([data.coverage.rootRef]);
      for (const node of data.nodes) {
        const visited = new Set<string>();
        let current: string | null = node.ref;
        while (current === null || !connected.has(current)) {
          require(current !== null && nodes.has(current), 'node disconnected from coverage root');
          require(!visited.has(current), 'node cycle');
          visited.add(current);
          current = nodes.get(current)!.parentRef;
        }
        for (const ref of visited) connected.add(ref);
      }
      break;
    }
    case 'prepared_operation':
      require(data.command.targetRef === data.binding.targetRef, 'bound target changed');
      require(data.originObservationId === data.binding.observationId, 'binding observation mismatch');
      require(data.binding.evidence.every(e => e.observationId === data.originObservationId), 'binding evidence observation mismatch');
      break;
    case 'decision': {
      const keys = Object.keys(data.probabilities);
      require(keys.length === data.options.length && data.options.every(o => Object.hasOwn(data.probabilities, o)), 'probability keys mismatch');
      require(Object.hasOwn(data.probabilities, data.selected), 'unknown selected option');
      const p = Object.values(data.probabilities);
      require(p.every(Number.isFinite) && Number.isFinite(data.confidence), 'nonfinite probability');
      require(Math.abs(p.reduce((a, b) => a + b, 0) - 1) <= 1e-6, 'distribution not normalized');
      require(data.probabilities[data.selected]! >= Math.max(...p) - 1e-9, 'selected option not maximal');
      break;
    }
    case 'task_result': {
      const checks = new Set(data.checks.map(c => c.checkId));
      require(checks.size === data.checks.length, 'duplicate result checks');
      if (data.status === 'verified_success') require(checks.size === data.requiredCheckIds.length && data.requiredCheckIds.every(id => checks.has(id)), 'missing required checks');
      break;
    }
    case 'read_task_result': {
      require(new Set(data.records.map(r => r.nodeRef)).size === data.records.length, 'duplicate projected nodes');
      require(data.records.length <= data.matchedNodeCount, 'projected count exceeds matches');
      require(data.outputTruncated === (data.records.length < data.matchedNodeCount), 'projection truncation inconsistent');
      const partial = data.source.coverage.status === 'partial' || data.selectionUncertain;
      require((data.source.coverage.status === 'partial') === (data.source.coverage.omittedReasons.length > 0), 'projection coverage inconsistent');
      require(data.status === (data.matchedNodeCount ? (partial || data.outputTruncated ? 'partial' : 'projected') : partial ? 'unknown' : 'no_match_in_observation'), 'projection status inconsistent');
      for (const record of data.records) {
        require(new Set(record.attributes.map(a => a.attribute)).size === record.attributes.length, 'duplicate projected attributes');
        for (const attr of record.attributes) if (attr.status === 'available') {
          require(attr.text.isWellFormed(), 'ill-formed projected Unicode');
          require(attr.evidence.observationId === data.source.observationId && attr.evidence.nodeRef === record.nodeRef && attr.evidence.attribute === attr.attribute, 'projection evidence mismatch');
          require(attr.evidence.start === 0 && attr.evidence.end === Array.from(attr.text).length, 'projection must quote full attribute');
        }
      }
      break;
    }
  }
}
/** Compare against the stored task, never the result's self-reported check list alone. */
export function validateResultForTask(result: TaskResult, task: TaskSpec): void {
  validateContract(task); validateContract(result);
  require(result.taskId === task.taskId && result.taskRevision === task.revision, 'result task identity mismatch');
  const required = task.requiredChecks.map(c => c.id);
  require(required.length === result.requiredCheckIds.length && required.every(id => result.requiredCheckIds.includes(id)), 'result changed task checks');
}
