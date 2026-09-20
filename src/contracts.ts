/** Runtime interfaces mirror the v0.1 JSON contracts; validators own input checks. */
export type Attribute<T> = { status: 'available'; value: T } | { status: 'unavailable' | 'unsupported' | 'redacted' | 'error' };
export type Role = 'application' | 'window' | 'dialog' | 'group' | 'text_field' | 'text_area' | 'button' | 'text' | 'unknown';
export type Capability = 'set_value' | 'invoke';
export interface Node {
  ref: string; parentRef: string | null; role: Role; nativeRole: string;
  name: Attribute<string>; value: Attribute<string>; enabled: Attribute<boolean>;
  capabilities: Capability[];
}
export interface EvidenceRef {
  observationId: string; nodeRef: string;
  field: 'name' | 'role' | 'parentRef' | 'value' | 'enabled' | 'capabilities';
}
export interface Budgets {
  maxOperations: number; maxSemanticRequests: number; maxObservationExpansions: number; deadlineMs: number;
}
export interface Slot { id: string; meaning: string; inputRef: string; regionHint: string }
export interface CheckSpec { id: string; kind: 'value_equals_input'; slotId: string; inputRef: string; comparison: 'exact' }
export interface TaskSpec {
  kind: 'task'; schemaVersion: '0.1'; taskId: string; revision: number; goal: string; scopeRef: string;
  recipeId: 'fill-fields.v1'; inputs: Record<string, string>; slots: Slot[]; requiredChecks: CheckSpec[]; budgets: Budgets;
}
export interface Observation {
  kind: 'observation'; schemaVersion: '0.1'; observationId: string; sessionEpoch: string; scopeRef: string;
  document?: DocumentStamp;
  capture: { startedMonoMs: number; endedMonoMs: number; eventSeqBefore: number; eventSeqAfter: number; consistency: 'best_effort' | 'atomic' };
  coverage: { rootRef: string; status: 'provider_exhausted' | 'partial'; omittedReasons: ('budget' | 'virtualized' | 'unsupported' | 'error' | 'redacted' | 'frame')[]; nodeCount: number };
  nodes: Node[];
}
export interface Binding { slotId: string; targetRef: string; observationId: string; source: 'profile' | 'operator' | 'semantic'; evidence: EvidenceRef[] }
export type Command = { kind: 'set_value'; targetRef: string; value: string } | { kind: 'invoke'; targetRef: string };
export interface PreparedOperation {
  kind: 'prepared_operation'; schemaVersion: '0.1'; preparedId: string; operationId: string; taskId: string; taskRevision: number;
  sessionEpoch: string; controlEpoch: number; scopeRef: string; grantRef: string; grantVersion: number; originObservationId: string;
  binding: Binding; command: Command; guardSetRef: string; expiresAtMonoMs: number;
}
export type ReceiptStatus = 'prepared' | 'dispatch_intent' | 'attempted' | 'not_dispatched' | 'expired' | 'outcome_unknown';
export interface HostReceipt {
  kind: 'host_receipt'; schemaVersion: '0.1'; operationId: string; sessionEpoch: string; eventSeq: number; status: ReceiptStatus;
  reason: 'none' | 'precondition_changed' | 'scope_denied' | 'cancelled_before_dispatch' | 'host_lost' | 'driver_timeout' | 'driver_error' | 'journal_error' | 'expired';
}
export type ResultStatus = 'verified_success' | 'completed_unverified' | 'blocked' | 'failed' | 'cancelled' | 'outcome_unknown';
export interface TaskResult {
  kind: 'task_result'; schemaVersion: '0.1'; taskId: string; taskRevision: number; status: ResultStatus;
  requiredCheckIds: string[]; checks: { checkId: string; status: 'pass' | 'fail' | 'unknown'; method: 'exact_readback' | 'presence' | 'semantic'; evidence: EvidenceRef[] }[];
  unresolvedOperationIds: string[];
  assurance: { targetBinding: 'profile' | 'operator' | 'semantic' | 'mixed'; effectCheck: 'deterministic' | 'semantic' | 'unavailable' | 'mixed'; environment: 'fixture_atomic' | 'external_best_effort' };
}
export interface Decision {
  kind: 'decision'; schemaVersion: '0.1'; decisionId: string; taskId: string; taskRevision: number; sessionEpoch: string;
  observationId: string; questionSetVersion: string; questionId: string; providerModel: string; stateDigest: string;
  options: string[]; selected: string; probabilities: Record<string, number>; confidence: number;
}
export type Contract = TaskSpec | BrowserActionTask | ReadSessionSpec | ReadTaskSpec | ReadTaskResult | Observation | PreparedOperation | HostReceipt | TaskResult | Decision;

/** Fixed operator task. Targets are selected from fresh observations, never from stored selectors. */
export interface BrowserActionTask {
  kind: 'browser_action_task'; schemaVersion: '0.1'; recipeId: 'browser-actions.v1';
  taskId: string; revision: number; scopeRef: string; goal: string;
  inputs: Record<string, string>;
  steps: ({ id: string; purpose: string; kind: 'invoke' } | { id: string; purpose: string; kind: 'set_value'; inputRef: string })[];
  requiredChecks: { id: string; attribute: 'name' | 'value'; text: string; match: 'equals' | 'contains' }[];
  limits: ReadLimits;
}
export interface BrowserActionPolicy {
  task: BrowserActionTask;
  setValueRoles: string[];
  invokeRoles: string[];
}
export interface BrowserActionSession extends ReadSession { attemptedStepIds: string[] }

export type TextAttribute = 'name' | 'value';
/** Literal projection only. Role filters are AX vocabulary, never semantic field names. */
export interface ReadTaskSpec {
  kind: 'read_task'; schemaVersion: '0.1'; taskId: string; revision: number;
  recipeId: 'project-ax-text.v1'; completeness: 'observed_region';
  readSessionId: string; scopeRef: string; document: DocumentStamp; rootRef?: string;
  nativeRoles: string[]; attributes: TextAttribute[];
  limits: { maxRecords: number; maxOutputBytes: number };
}
export interface LiteralSpan {
  observationId: string; nodeRef: string; attribute: TextAttribute;
  start: number; end: number; unit: 'unicode_scalar';
}
export type ProjectedAttribute =
  | { attribute: TextAttribute; status: 'available'; text: string; evidence: LiteralSpan }
  | { attribute: TextAttribute; status: 'unavailable' | 'unsupported' | 'redacted' | 'error' };
export interface ProjectedNode {
  nodeRef: string; parentRef: string | null; nativeRole: string; attributes: ProjectedAttribute[];
}
export interface ReadTaskResult {
  kind: 'read_task_result'; schemaVersion: '0.1'; taskId: string; taskRevision: number; taskDigest: string;
  recipeId: 'project-ax-text.v1'; completeness: 'observed_region'; mapping: 'ax_node_attributes';
  status: 'projected' | 'partial' | 'no_match_in_observation' | 'unknown';
  source: { readSessionId: string; scopeRef: string; observationId: string; observationDigest: string;
    document: DocumentStamp; coverage: Observation['coverage']; capture: Observation['capture'] };
  matchedNodeCount: number; selectionUncertain: boolean; outputTruncated: boolean; records: ProjectedNode[];
  modelCalls: 0; operations: 0;
}

export interface ReadLimits {
  maxNodes: number; maxDepth: number; maxBytes: number; maxCaptureMs: number; maxCaptures: number; deadlineMs: number;
}
export interface PageScope { origins: string[] }
export interface ReadSessionSpec {
  kind: 'read_session'; schemaVersion: '0.1'; readSessionId: string; scopeRef: string; limits: ReadLimits;
}
export interface DocumentStamp { sessionEpoch: string; ref: string; generation: number }
export interface ReadSession extends Session { document: DocumentStamp }
export interface ReadObservation extends Observation { document: DocumentStamp }
export interface ReadHost {
  openRead(spec: ReadSessionSpec): Promise<ReadSession>;
  refreshPage(): Promise<DocumentStamp>;
  read(document: DocumentStamp, rootRef?: string): Promise<ReadObservation>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}

/** Issued by the operator; a Task's scopeRef cannot create a grant. */
export interface ScopeGrant {
  scopeRef: string; grantRef: string; version: number; read: boolean; model: boolean; act: boolean;
  allowedCommands: Capability[]; appId: string; windowRef: string; limits: Budgets;
  actionPolicy?: BrowserActionPolicy;
  allowedActions?: ('fixture.submit' | 'fixture.replace_field' | 'fixture.show_modal')[];
  pageScope?: PageScope;
  readLimits?: ReadLimits;
}
export interface Session { sessionEpoch: string; controlEpoch: number; scopeRef: string; grantRef: string; grantVersion: number; unresolvedOperationIds?: string[] }
export type ObservationQuery = 'window_summary' | 'active_dialog' | 'editable_fields' | 'element_context' | 'changes_since';
export interface PrepareRequest { operationId: string; taskId: string; taskRevision: number; sessionEpoch: string; binding: Binding; command: Command }
export interface Host {
  openSession(task: TaskSpec): Promise<Session>;
  capture(query?: ObservationQuery): Promise<Observation>;
  prepare(request: PrepareRequest): Promise<PreparedOperation>;
  commit(preparedId: string): Promise<HostReceipt>;
  status(operationId: string): Promise<HostReceipt | null>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}
export class HostError extends Error {
  constructor(public readonly code: 'scope_denied' | 'invalid_request' | 'stale_session' | 'stale_binding' | 'unsupported' | 'cancelled' | 'outcome_unknown' | 'journal_error' | 'closed', message: string) {
    super(message); this.name = 'HostError';
  }
}
