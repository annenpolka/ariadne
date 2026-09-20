import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { HostError } from './contracts.js';
import type { LiteralSpan, Node, ProjectedNode, ReadHost, ReadObservation, ReadSession, ReadSessionSpec, ReadTaskResult, ReadTaskSpec } from './contracts.js';
import { validateContract } from './validation.js';
import { readLimitRanges } from './browser-limits.generated.js';

function require(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid read projection: ${message}`);
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value)!;
}
function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
function bytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value)); }

/** A span is a quote from this supplied observation, not proof of a semantic field or live freshness. */
export function resolveLiteralSpan(observation: ReadObservation, span: LiteralSpan): string {
  return resolveNodeSpan(observation.observationId, observation.nodes.find(n => n.ref === span.nodeRef), span);
}
function resolveNodeSpan(observationId: string, node: Node | undefined, span: LiteralSpan): string {
  require(span.observationId === observationId, 'foreign observation');
  require(span.unit === 'unicode_scalar' && (span.attribute === 'name' || span.attribute === 'value'), 'invalid span unit/attribute');
  require(node && node.ref === span.nodeRef, 'unknown node reference');
  const attribute = node[span.attribute];
  require(attribute.status === 'available', 'attribute is not available');
  require(attribute.value.isWellFormed(), 'ill-formed Unicode');
  const scalars = Array.from(attribute.value);
  require(Number.isSafeInteger(span.start) && Number.isSafeInteger(span.end) && span.start >= 0 && span.start <= span.end && span.end <= scalars.length, 'invalid span bounds');
  return scalars.slice(span.start, span.end).join('');
}

/** Keeps the original task and single observation private and immutable while results are inspected. */
export class ReadProjection {
  readonly #task: ReadTaskSpec;
  readonly #observation: ReadObservation;
  readonly #taskDigest: string;
  readonly #observationDigest: string;
  constructor(task: ReadTaskSpec, observation: ReadObservation) {
    validateContract(task); validateContract(observation);
    require(bytes(observation) <= readLimitRanges.maxBytes[1], 'observation exceeds read byte ceiling');
    require(observation.document && isDeepStrictEqual(task.document, observation.document), 'document mismatch');
    require(task.scopeRef === observation.scopeRef, 'scope mismatch');
    require(task.rootRef === undefined || task.rootRef === observation.coverage.rootRef, 'region mismatch');
    this.#task = freeze(structuredClone(task));
    this.#observation = freeze(structuredClone(observation));
    this.#taskDigest = digest(this.#task);
    this.#observationDigest = digest(this.#observation);
  }
  project(): ReadTaskResult {
    const task = this.#task, observation = this.#observation;
    const nodes = observation.nodes.filter(n => task.nativeRoles.length === 0 || task.nativeRoles.includes(n.nativeRole));
    const result: ReadTaskResult = {
      kind: 'read_task_result', schemaVersion: '0.1', taskId: task.taskId, taskRevision: task.revision, taskDigest: this.#taskDigest,
      recipeId: task.recipeId, completeness: task.completeness, mapping: 'ax_node_attributes', status: 'partial',
      source: { readSessionId: task.readSessionId, scopeRef: task.scopeRef, observationId: observation.observationId,
        observationDigest: this.#observationDigest, document: structuredClone(observation.document), coverage: structuredClone(observation.coverage), capture: structuredClone(observation.capture) },
      matchedNodeCount: nodes.length, selectionUncertain: task.nativeRoles.length > 0 && observation.nodes.some(n => !/^AX[A-Za-z0-9]+$/.test(n.nativeRole)), outputTruncated: false, records: [], modelCalls: 0, operations: 0,
    };
    // Reserve the longer final status and false boolean. The final envelope, including evidence,
    // fits the output budget; a truncated result is always a prefix in observation order.
    const overhead = bytes({ ...result, status: 'no_match_in_observation' }) + 1; // newline on the wire/disk
    require(overhead <= task.limits.maxOutputBytes, 'output envelope exceeds budget');
    let used = overhead;
    for (const node of nodes) {
      if (result.records.length === task.limits.maxRecords) break;
      const record: ProjectedNode = { nodeRef: node.ref, parentRef: node.parentRef, nativeRole: node.nativeRole,
        attributes: task.attributes.map(attribute => {
          const source = node[attribute];
          if (source.status !== 'available') return { attribute, status: source.status };
          const evidence: LiteralSpan = { observationId: observation.observationId, nodeRef: node.ref, attribute,
            start: 0, end: Array.from(source.value).length, unit: 'unicode_scalar' };
          return { attribute, status: 'available', text: resolveNodeSpan(observation.observationId, node, evidence), evidence };
        }) };
      const size = bytes(record) + (result.records.length === 0 ? 0 : 1);
      if (used + size > task.limits.maxOutputBytes) break;
      result.records.push(record); used += size;
    }
    result.outputTruncated = result.records.length < nodes.length;
    const uncertain = result.selectionUncertain || observation.coverage.status === 'partial';
    result.status = nodes.length === 0 ? (uncertain ? 'unknown' : 'no_match_in_observation')
      : result.outputTruncated || uncertain ? 'partial' : 'projected';
    validateContract(result);
    return result;
  }
  /** Validate independently of project(); the expected node/attribute, not just a matching quote, is fixed. */
  verify(result: unknown): void {
    validateContract(result);
    require(result.kind === 'read_task_result', 'wrong result kind');
    const task = this.#task, observation = this.#observation;
    require(result.taskId === task.taskId && result.taskRevision === task.revision && result.taskDigest === this.#taskDigest, 'task changed');
    require(isDeepStrictEqual(result.source, { readSessionId: task.readSessionId, scopeRef: task.scopeRef,
      observationId: observation.observationId, observationDigest: this.#observationDigest, document: observation.document,
      coverage: observation.coverage, capture: observation.capture }), 'source changed');
    const matching = [];
    for (const node of observation.nodes) if (!task.nativeRoles.length || task.nativeRoles.some(role => role === node.nativeRole)) matching.push(node);
    require(result.matchedNodeCount === matching.length, 'matched count changed');
    require(result.selectionUncertain === (task.nativeRoles.length > 0 && observation.nodes.some(n => !/^AX[A-Za-z0-9]+$/.test(n.nativeRole))), 'selection uncertainty changed');
    require(result.records.length <= matching.length && result.records.length <= task.limits.maxRecords && bytes(result) + 1 <= task.limits.maxOutputBytes, 'output exceeds limit');
    let used = bytes({ ...result, records: [], outputTruncated: false, status: 'no_match_in_observation' }) + 1;
    for (let index = 0; index < result.records.length; index++) {
      const record = result.records[index]!, node = matching[index]!;
      require(record.nodeRef === node.ref && record.parentRef === node.parentRef && record.nativeRole === node.nativeRole, 'wrong node or order');
      require(record.attributes.length === task.attributes.length, 'missing attribute');
      for (let j = 0; j < task.attributes.length; j++) {
        const attribute = task.attributes[j]!, field = record.attributes[j]!, original = node[attribute];
        require(field.attribute === attribute && field.status === original.status, 'wrong attribute or state');
        if (field.status === 'available') {
          require(original.status === 'available' && original.value.isWellFormed(), 'invalid literal');
          const span = field.evidence;
          require(span.nodeRef === node.ref && span.attribute === attribute && span.start === 0 && span.end === Array.from(original.value).length, 'wrong node, attribute or full span');
          require(field.text === resolveNodeSpan(observation.observationId, node, span), 'literal changed');
        }
      }
      used += bytes(record) + (index ? 1 : 0);
    }
    require(used <= task.limits.maxOutputBytes, 'output exceeds reserved envelope');
    require(result.outputTruncated === (result.records.length < matching.length), 'truncation changed');
    if (result.outputTruncated && result.records.length < task.limits.maxRecords) {
      const next = matching[result.records.length]!;
      // Account for the next complete record independently; arbitrary omissions are not budget truncation.
      const attributes = task.attributes.map(attribute => {
        const value = next[attribute];
        return value.status === 'available' ? { attribute, status: value.status, text: value.value, evidence: {
          observationId: observation.observationId, nodeRef: next.ref, attribute, start: 0, end: Array.from(value.value).length, unit: 'unicode_scalar',
        } } : { attribute, status: value.status };
      });
      require(used + (result.records.length ? 1 : 0) + bytes({ nodeRef: next.ref, parentRef: next.parentRef, nativeRole: next.nativeRole, attributes }) > task.limits.maxOutputBytes, 'unjustified omission');
    }
    const uncertain = observation.coverage.status === 'partial' || result.selectionUncertain;
    const status = matching.length ? (uncertain || result.outputTruncated ? 'partial' : 'projected') : (uncertain ? 'unknown' : 'no_match_in_observation');
    require(result.status === status, 'status changed');
  }
}

/** One read, no model/provider callback and no mutation APIs. Host owns authority, deadline and refresh fences. */
export async function runReadTask(host: Pick<ReadHost, 'read'>, spec: ReadSessionSpec, session: ReadSession, task: ReadTaskSpec, signal?: AbortSignal): Promise<{ task: ReadTaskSpec; observation: ReadObservation; result: ReadTaskResult }> {
  validateContract(spec); validateContract(task);
  const fixed = freeze(structuredClone(task));
  require(fixed.readSessionId === spec.readSessionId && fixed.scopeRef === spec.scopeRef && fixed.scopeRef === session.scopeRef, 'read session mismatch');
  require(session.sessionEpoch === fixed.document.sessionEpoch && isDeepStrictEqual(fixed.document, session.document), 'session document mismatch');
  const cancelled = () => { if (signal?.aborted) throw new HostError('cancelled', 'Read task cancelled'); };
  cancelled();
  const observation = freeze(structuredClone(await host.read(structuredClone(fixed.document), fixed.rootRef)));
  cancelled();
  const projection = new ReadProjection(fixed, observation);
  const result = projection.project();
  projection.verify(result);
  return { task: fixed, observation, result };
}
