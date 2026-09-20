import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateContract, validateResultForTask } from '../src/validation.js';
import type { Decision, Observation, TaskResult } from '../src/contracts.js';
import { loadExample, task } from './helpers.js';

for (const name of ['task', 'observation', 'prepared-operation', 'host-receipt', 'task-result', 'decision']) {
  test(`accept existing contract: ${name}`, () => validateContract(loadExample(name)));
}
test('reject vacuous success and input/check substitution', () => {
  const input = task(); input.requiredChecks = []; assert.throws(() => validateContract(input));
  const changed = task(); changed.requiredChecks[0]!.inputRef = 'other'; assert.throws(() => validateContract(changed));
});
test('compare result required checks against the original task', () => {
  const result = loadExample<TaskResult>('task-result');
  result.requiredCheckIds = ['invented']; result.checks[0]!.checkId = 'invented';
  validateContract(result);
  assert.throws(() => validateResultForTask(result, task()), /changed task checks/);
});
test('reject disconnected observation nodes and cycles', () => {
  const observation = loadExample<Observation>('observation');
  observation.nodes[2]!.parentRef = 'missing'; assert.throws(() => validateContract(observation));
  observation.nodes[2]!.parentRef = 'node-email'; assert.throws(() => validateContract(observation));
});
test('larger read trees do not widen the legacy Task observation boundary', () => {
  const observation = loadExample<Observation>('read-observation');
  const leaf = observation.nodes[1]!;
  observation.nodes.push(...Array.from({ length: 2047 }, (_, i) => ({ ...leaf, ref: `extra-${i}` })));
  observation.coverage.nodeCount = observation.nodes.length;
  validateContract(observation);
  delete observation.document;
  assert.throws(() => validateContract(observation));
});
for (const mutation of [
  (d: Decision) => { d.confidence = NaN; },
  (d: Decision) => { d.probabilities['candidate_contact'] = Infinity; },
  (d: Decision) => { delete d.probabilities['need_more_observation']; },
  (d: Decision) => { d.selected = 'need_more_observation'; },
  (d: Decision) => { d.probabilities['candidate_contact'] = 0.7; },
]) test(`reject invalid semantic answer: ${mutation.toString()}`, () => {
  const decision = loadExample<Decision>('decision'); mutation(decision); assert.throws(() => validateContract(decision));
});
