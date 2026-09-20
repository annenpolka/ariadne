import { readFileSync } from 'node:fs';
import type { Binding, Observation, ScopeGrant, TaskSpec } from '../src/contracts.js';
export const loadExample = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../examples/${name}.json`, import.meta.url), 'utf8')) as T;
export const task = (): TaskSpec => loadExample('task');
export const nodes = () => loadExample<Observation>('observation').nodes;
export const grant = (): ScopeGrant => ({ scopeRef: 'scope-fixture', grantRef: 'grant-fixture', version: 1, read: true, model: false, act: true, allowedCommands: ['set_value', 'invoke'], appId: 'ariadne.fixture', windowRef: 'node-window', limits: task().budgets });
export const binding = (observation: Observation): Binding => ({ slotId: 'contactEmail', targetRef: 'node-email', observationId: observation.observationId, source: 'profile', evidence: [{ observationId: observation.observationId, nodeRef: 'node-email', field: 'name' }, { observationId: observation.observationId, nodeRef: 'node-contact', field: 'name' }] });
