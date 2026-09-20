import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { HostError, type Capability, type Host, type HostReceipt, type Observation, type ObservationQuery, type PreparedOperation, type PrepareRequest, type Session, type TaskSpec } from '../contracts.js';
import { validateContract } from '../validation.js';
import type { DocumentStamp, ReadHost, ReadObservation, ReadSession, ReadSessionSpec } from '../contracts.js';

export interface RpcHostOptions {
  executable: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxMessageBytes?: number;
  onDiagnostic?: (message: string) => void;
}
interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const keys = (value: Record<string, unknown>, required: string[], optional: string[] = []): boolean => required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const codes = new Set(['scope_denied', 'invalid_request', 'stale_session', 'stale_binding', 'unsupported', 'cancelled', 'outcome_unknown', 'journal_error', 'closed']);

/** Local stdio transport. It never retries a side effect or restarts a lost host. */
export class RpcHost implements Host, ReadHost {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly timeoutMs: number;
  private readonly explicitTimeout: boolean;
  private maxBytes: number;
  private readonly explicitMaxBytes: boolean;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly expired = new Set<number>();
  private chunks: Buffer[] = [];
  private bufferedBytes = 0;
  private failure: HostError | undefined;
  private readonly ready: Promise<void>;
  private readonly exited: Promise<void>;
  private helloEpoch: string | undefined;
  capabilities: readonly Capability[] = [];
  private mode: 'task' | 'read' | undefined;
  private readSpec: ReadSessionSpec | undefined;
  private document: DocumentStamp | undefined;
  private documentGeneration = 0;
  private readRevision = 0;
  private readStopped = false;

  constructor(options: RpcHostOptions) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.explicitTimeout = options.timeoutMs !== undefined;
    this.maxBytes = options.maxMessageBytes ?? 1024 * 1024;
    this.explicitMaxBytes = options.maxMessageBytes !== undefined;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || !Number.isSafeInteger(this.maxBytes) || this.maxBytes < 128) throw new HostError('invalid_request', 'Invalid RPC limits');
    this.child = spawn(options.executable, options.args ?? [], { stdio: ['pipe', 'pipe', 'pipe'], ...(options.env ? { env: options.env } : {}), shell: false });
    // The host owns its diagnostic contents; drain stderr without copying screen values into errors.
    if (options.onDiagnostic) this.child.stderr.on('data', (bytes: Buffer) => options.onDiagnostic!(bytes.toString('utf8')));
    else this.child.stderr.resume();
    this.child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
    this.child.stdin.on('error', () => this.fail('Host input pipe failed'));
    this.child.on('error', () => this.fail('Cannot start host'));
    this.exited = new Promise(resolve => this.child.once('close', () => { this.fail('Host exited'); resolve(); }));
    this.ready = this.request('host.hello', {}).then(value => {
      if (!object(value) || !keys(value, ['protocolVersion', 'schemaVersion', 'sessionEpoch', 'capabilities', 'platform']) || value['protocolVersion'] !== '1' || value['schemaVersion'] !== '0.1' || value['platform'] !== 'macos' || !id(value['sessionEpoch']) || !Array.isArray(value['capabilities']) || value['capabilities'].some(cap => !['set_value', 'invoke'].includes(cap)) || new Set(value['capabilities']).size !== value['capabilities'].length) throw new HostError('invalid_request', 'Unsupported host handshake');
      this.helloEpoch = value['sessionEpoch']; this.capabilities = Object.freeze([...value['capabilities']]) as Capability[];
    }).catch(error => { this.fail('Host handshake failed'); throw error; });
    // Construction can precede the first awaited operation; do not emit an unhandled rejection.
    void this.ready.catch(() => undefined);
  }
  async openSession(task: TaskSpec): Promise<Session> {
    if (this.mode === 'read') throw new HostError('scope_denied', 'Read session cannot open a Task');
    this.mode = 'task';
    validateContract(task); await this.ready;
    const value = await this.request('session.open', { task });
    if (!object(value) || !keys(value, ['sessionEpoch', 'controlEpoch', 'scopeRef', 'grantRef', 'grantVersion'], ['unresolvedOperationIds']) || value['sessionEpoch'] !== this.helloEpoch || value['scopeRef'] !== task.scopeRef || !id(value['grantRef']) || !Number.isSafeInteger(value['controlEpoch']) || (value['controlEpoch'] as number) < 0 || !Number.isSafeInteger(value['grantVersion']) || (value['grantVersion'] as number) < 1 || (value['unresolvedOperationIds'] !== undefined && (!Array.isArray(value['unresolvedOperationIds']) || value['unresolvedOperationIds'].some(item => !id(item)) || new Set(value['unresolvedOperationIds']).size !== value['unresolvedOperationIds'].length))) throw new HostError('invalid_request', 'Invalid host session');
    return value as unknown as Session;
  }
  async openRead(spec: ReadSessionSpec): Promise<ReadSession> {
    validateContract(spec);
    if (spec.kind !== 'read_session' || this.mode !== undefined || this.readStopped) throw new HostError('scope_denied', 'Read session cannot be reopened');
    this.mode = 'read'; this.readSpec = structuredClone(spec);
    // The read payload budget excludes its JSON-RPC envelope. Preserve an explicit
    // operator transport ceiling, and leave the legacy Task transport limit unchanged.
    if (!this.explicitMaxBytes) this.maxBytes = Math.max(this.maxBytes, spec.limits.maxBytes + 64 * 1024);
    await this.ready;
    if (this.capabilities.length) throw new HostError('scope_denied', 'Read host exposes action capabilities');
    const revision = this.readRevision;
    const value = await this.request('session.openRead', { spec: this.readSpec });
    if (!object(value) || !keys(value, ['sessionEpoch', 'controlEpoch', 'scopeRef', 'grantRef', 'grantVersion', 'document'], ['unresolvedOperationIds']) || value['sessionEpoch'] !== this.helloEpoch || value['scopeRef'] !== this.readSpec.scopeRef || !id(value['grantRef']) || !Number.isSafeInteger(value['controlEpoch']) || (value['controlEpoch'] as number) < 0 || !Number.isSafeInteger(value['grantVersion']) || (value['grantVersion'] as number) < 1 || (value['unresolvedOperationIds'] !== undefined && (!Array.isArray(value['unresolvedOperationIds']) || value['unresolvedOperationIds'].some(item => !id(item)) || new Set(value['unresolvedOperationIds']).size !== value['unresolvedOperationIds'].length))) throw new HostError('invalid_request', 'Invalid host read session');
    const document = this.checkDocument(value['document']);
    this.checkReadRevision(revision);
    this.document = structuredClone(document); this.documentGeneration = document.generation;
    return value as unknown as ReadSession;
  }
  async refreshPage(): Promise<DocumentStamp> {
    if (!this.readSpec || this.readStopped) throw new HostError('scope_denied', 'No active read session');
    await this.ready;
    this.document = undefined;
    const revision = ++this.readRevision;
    const document = this.checkDocument(await this.request('page.refresh', {}));
    this.checkReadRevision(revision);
    if (document.generation <= this.documentGeneration) throw new HostError('stale_binding', 'Document generation did not advance');
    this.document = structuredClone(document); this.documentGeneration = document.generation;
    return document;
  }
  async read(document: DocumentStamp, rootRef?: string): Promise<ReadObservation> {
    if (!this.readSpec || !this.document || this.readStopped || !isDeepStrictEqual(this.document, document)) throw new HostError('stale_binding', 'No current document reference');
    if (rootRef !== undefined && !id(rootRef)) throw new HostError('invalid_request', 'Invalid region reference');
    const expected = structuredClone(document), revision = this.readRevision;
    await this.ready;
    let value: ReadObservation;
    try {
      const timeout = this.explicitTimeout ? this.timeoutMs : Math.max(this.timeoutMs, this.readSpec.limits.maxCaptureMs + 5000);
      value = this.contract<ReadObservation>(await this.request('observation.read', { document: expected, ...(rootRef === undefined ? {} : { rootRef }) }, timeout), 'observation');
    } catch (error) {
      if (error instanceof HostError && ['stale_binding', 'stale_session', 'scope_denied'].includes(error.code)) this.document = undefined;
      throw error;
    }
    this.checkReadRevision(revision);
    if (value.sessionEpoch !== this.helloEpoch || value.scopeRef !== this.readSpec.scopeRef || !isDeepStrictEqual(value.document, expected)) throw new HostError('stale_binding', 'Foreign read observation');
    if (value.nodes.some(node => node.capabilities.length) || value.nodes.length > this.readSpec.limits.maxNodes || Buffer.byteLength(JSON.stringify(value)) > this.readSpec.limits.maxBytes || (rootRef !== undefined && value.coverage.rootRef !== rootRef) || value.nodes.find(n => n.ref === value.coverage.rootRef)?.parentRef !== null) throw new HostError('invalid_request', 'Read observation violates limits or region');
    return value;
  }
  private checkDocument(value: unknown): DocumentStamp {
    if (!object(value) || !keys(value, ['sessionEpoch', 'ref', 'generation']) || value['sessionEpoch'] !== this.helloEpoch || !id(value['ref']) || !Number.isSafeInteger(value['generation']) || (value['generation'] as number) < 1) throw new HostError('invalid_request', 'Invalid document stamp');
    return value as unknown as DocumentStamp;
  }
  private checkReadRevision(revision: number): void {
    if (this.readStopped) throw new HostError('cancelled', 'Read session stopped');
    if (revision !== this.readRevision) throw new HostError('stale_binding', 'Read superseded by refresh');
  }
  async capture(query: ObservationQuery = 'editable_fields'): Promise<Observation> {
    if (this.mode === 'read') throw new HostError('scope_denied', 'Read session requires a document reference');
    await this.ready; const value = this.contract<Observation>(await this.request('observation.capture', { query }), 'observation');
    if (value.sessionEpoch !== this.helloEpoch) throw new HostError('stale_session', 'Foreign observation epoch');
    if (value.document !== undefined) throw new HostError('invalid_request', 'Task capture cannot return a read-session observation');
    return value;
  }
  async prepare(request: PrepareRequest): Promise<PreparedOperation> {
    if (this.mode === 'read') throw new HostError('scope_denied', 'Read session cannot prepare');
    await this.ready; const value = this.contract<PreparedOperation>(await this.request('operation.prepare', request), 'prepared_operation');
    if (value.operationId !== request.operationId || value.taskId !== request.taskId || value.taskRevision !== request.taskRevision || value.sessionEpoch !== request.sessionEpoch || !isDeepStrictEqual(value.command, request.command) || !isDeepStrictEqual(value.binding, request.binding)) throw new HostError('invalid_request', 'Host changed the prepared operation');
    return value;
  }
  async commit(preparedId: string): Promise<HostReceipt> { if (this.mode === 'read') throw new HostError('scope_denied', 'Read session cannot commit'); await this.ready; return this.contract<HostReceipt>(await this.request('operation.commit', { preparedId }), 'host_receipt'); }
  async status(operationId: string): Promise<HostReceipt | null> {
    await this.ready; const raw = await this.request('operation.status', { operationId }); if (raw === null) return null;
    const value = this.contract<HostReceipt>(raw, 'host_receipt');
    if (value.operationId !== operationId) throw new HostError('invalid_request', 'Host status names a different operation'); return value;
  }
  async cancel(): Promise<void> { this.readStopped = true; ++this.readRevision; this.document = undefined; await this.ready; if (await this.request('session.cancel', {}) !== null) throw new HostError('invalid_request', 'Invalid cancel response'); }
  async close(): Promise<void> {
    this.readStopped = true; ++this.readRevision; this.document = undefined;
    try { await this.ready; if (!this.failure && await this.request('session.close', {}, Math.min(this.timeoutMs, 1000)) !== null) throw new HostError('invalid_request', 'Invalid close response'); }
    finally { this.child.stdin.end(); const timer = setTimeout(() => this.child.kill('SIGKILL'), 1000); try { await this.exited; } finally { clearTimeout(timer); } }
  }
  private contract<T>(value: unknown, kind: string): T {
    validateContract(value); if (!object(value) || value['kind'] !== kind) throw new HostError('invalid_request', 'Wrong host response kind'); return value as T;
  }
  private request(method: string, params: unknown, timeout = this.timeoutMs): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending.size >= 64) return Promise.reject(new HostError('invalid_request', 'Too many pending RPC requests'));
    const requestId = ++this.nextId; const bytes = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
    if (bytes.length > this.maxBytes) return Promise.reject(new HostError('invalid_request', 'RPC request exceeds byte limit'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId); this.expired.add(requestId);
        if (this.expired.size > 1024) this.expired.delete(this.expired.values().next().value!);
        reject(new HostError('closed', `${method} response timed out; execution was not retried`));
      }, timeout);
      this.pending.set(requestId, { resolve, reject, timer });
      this.child.stdin.write(bytes);
    });
  }
  private receive(chunk: Buffer): void {
    if (this.failure) return;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset), end = newline === -1 ? chunk.length : newline;
      const part = chunk.subarray(offset, end);
      this.bufferedBytes += part.length;
      if (this.bufferedBytes + (newline === -1 ? 0 : 1) > this.maxBytes) { this.fail('Host response exceeds byte limit'); return; }
      if (part.length) this.chunks.push(part);
      if (newline === -1) return;
      // Concatenate once per complete message, rather than copying every accumulated
      // prefix for each pipe chunk (quadratic work for multi-megabyte observations).
      const line = Buffer.concat(this.chunks, this.bufferedBytes);
      this.chunks = []; this.bufferedBytes = 0; offset = newline + 1;
      let value: unknown; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)); } catch { this.fail('Host emitted malformed JSON'); return; }
      if (!object(value) || value['jsonrpc'] !== '2.0' || !Number.isSafeInteger(value['id']) || !(keys(value, ['jsonrpc', 'id', 'result']) || keys(value, ['jsonrpc', 'id', 'error']))) { this.fail('Host emitted an invalid RPC envelope'); return; }
      const requestId = value['id'] as number; const pending = this.pending.get(requestId);
      if (!pending) { if (this.expired.delete(requestId)) continue; this.fail('Host responded with an unknown request ID'); return; }
      if (Object.hasOwn(value, 'error')) {
        const error = value['error'];
        if (!object(error) || !keys(error, ['code', 'message'], ['data']) || !Number.isInteger(error['code']) || typeof error['message'] !== 'string') { this.fail('Host emitted an invalid RPC error'); return; }
        const code = object(error['data']) && codes.has(error['data']['code'] as string) ? error['data']['code'] as HostError['code'] : 'invalid_request';
        pending.reject(new HostError(code, error['message']));
      } else pending.resolve(value['result']);
      clearTimeout(pending.timer); this.pending.delete(requestId);
    }
  }
  private fail(message: string): void {
    if (this.failure) return; this.failure = new HostError('closed', message);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(this.failure); } this.pending.clear(); this.child.kill('SIGTERM');
    this.chunks = []; this.bufferedBytes = 0;
  }
}
