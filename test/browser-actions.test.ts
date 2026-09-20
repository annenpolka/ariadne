import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateContract } from '../src/validation.js';
import { validateGrant, browserSetValueRoles, browserInvokeRoles } from '../src/grants.js';
import { checkActionObservation } from '../src/browser-actions.js';
import { browserOperationId } from '../src/host/rpc-host.js';
import type { BrowserActionTask, ScopeGrant, ReadObservation } from '../src/contracts.js';

export function actionTask(): BrowserActionTask { return JSON.parse(readFileSync('examples/browser-action-task.json', 'utf8')); }
export function actionGrant(task = actionTask(), origin = 'https://example.org'): ScopeGrant {
  return { scopeRef: task.scopeRef, grantRef: 'grant-actions', version: 1, appId: 'ariadne.chrome', windowRef: 'browser-page',
    read: true, model: false, act: true, allowedCommands: ['set_value', 'invoke'],
    limits: { maxOperations: task.steps.length, maxSemanticRequests: 0, maxObservationExpansions: 0, deadlineMs: task.limits.deadlineMs },
    readLimits: { ...task.limits }, pageScope: { origins: [origin] },
    actionPolicy: { task: structuredClone(task), setValueRoles: browserSetValueRoles, invokeRoles: browserInvokeRoles } };
}
test('browser task pins inputs, ordered steps, nonempty checks and bounds', () => {
  validateContract(actionTask());
  for (const mutate of [
    (t: BrowserActionTask) => { t.steps.push(t.steps[0]!); },
    (t: BrowserActionTask) => { t.requiredChecks = []; },
    (t: BrowserActionTask) => { delete t.inputs.title; },
    (t: BrowserActionTask) => { Object.assign(t.steps[1]!, { value: 'arbitrary' }); },
  ]) { const t = actionTask(); mutate(t); assert.throws(() => validateContract(t)); }
});
test('browser action grant requires an authorized task and bounded roles without widening read grants', () => {
  validateGrant(actionGrant());
  for (const mutate of [
    (g: ScopeGrant) => { delete g.actionPolicy; },
    (g: ScopeGrant) => { g.act = false; },
    (g: ScopeGrant) => { g.model = true; },
    (g: ScopeGrant) => { g.actionPolicy!.setValueRoles = ['AXGroup']; },
    (g: ScopeGrant) => { g.actionPolicy!.invokeRoles = ['AXWindow']; },
    (g: ScopeGrant) => { g.limits.maxOperations = 1; },
    (g: ScopeGrant) => { g.readLimits!.deadlineMs = 1000; },
    (g: ScopeGrant) => { g.actionPolicy!.task.scopeRef = 'other'; },
  ]) { const g = actionGrant(); mutate(g); assert.throws(() => validateGrant(g)); }
});
test('screen verification preserves the fixed expected literals and unavailable evidence', () => {
  const task = actionTask();
  const obs = JSON.parse(readFileSync('examples/read-observation.json', 'utf8')) as ReadObservation;
  obs.scopeRef = task.scopeRef;
  assert.equal(checkActionObservation(task, obs)[0]!.status, 'unknown');
  obs.nodes[1]!.name = { status: 'available', value: 'Saved Synthetic example' };
  assert.deepEqual(checkActionObservation(task, obs)[0], { checkId: 'saved-title', status: 'pass', evidence: [{ observationId: obs.observationId, nodeRef: obs.nodes[1]!.ref, field: 'name' }] });
  obs.nodes[1]!.name = { status: 'unavailable' };
  assert.equal(checkActionObservation(task, obs)[0]!.status, 'unknown');
});
test('operation identity is deterministic per fixed task revision and step', () => {
  const t = actionTask(); assert.equal(browserOperationId(t, 'save'), browserOperationId(structuredClone(t), 'save'));
  assert.notEqual(browserOperationId(t, 'save'), browserOperationId(t, 'review'));
  assert.notEqual(browserOperationId(t, 'save'), browserOperationId({ ...t, revision: 2 }, 'save'));
});
