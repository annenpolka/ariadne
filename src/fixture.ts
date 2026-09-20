import type { Command, Node } from './contracts.js';

export interface FixtureSnapshot {
  nodes: Node[]; appId: string; appGeneration: number; windowRef: string;
  focusedWindowRef: string; modalRef: string | null; eventSeq: number;
}
/** Oracle-only state. Do not put dispatch counts or business IDs in model input. */
export class FakeFixture {
  private state: FixtureSnapshot;
  private calls: Command[] = [];
  constructor(nodes: Node[], appId = 'ariadne.fixture', windowRef = 'node-window') {
    this.state = { nodes: structuredClone(nodes), appId, appGeneration: 1, windowRef, focusedWindowRef: windowRef, modalRef: null, eventSeq: 0 };
  }
  snapshot(): FixtureSnapshot { return structuredClone(this.state); }
  get dispatchCount(): number { return this.calls.length; }
  get operations(): Command[] { return structuredClone(this.calls); }
  readValue(ref: string): string | undefined {
    const value = this.state.nodes.find(n => n.ref === ref)?.value;
    return value?.status === 'available' ? value.value : undefined;
  }
  mutate(ref: string, patch: Partial<Node>): void {
    const node = this.state.nodes.find(n => n.ref === ref);
    if (!node) throw new Error(`Fixture node missing: ${ref}`);
    Object.assign(node, structuredClone(patch)); this.state.eventSeq++;
  }
  setModal(ref: string | null): void { this.state.modalRef = ref; this.state.eventSeq++; }
  setFocus(windowRef: string): void { this.state.focusedWindowRef = windowRef; this.state.eventSeq++; }
  restartApp(): void { this.state.appGeneration++; this.state.eventSeq++; }
  /** Synchronous driver boundary; caller must validate every precondition immediately before it. */
  dispatch(command: Command): void {
    const node = this.state.nodes.find(n => n.ref === command.targetRef);
    if (!node || node.enabled.status !== 'available' || !node.enabled.value || !node.capabilities.includes(command.kind)) throw new Error('Fixture target is not actionable');
    this.calls.push(structuredClone(command));
    if (command.kind === 'set_value') node.value = { status: 'available', value: command.value };
    this.state.eventSeq++;
  }
}
