import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileBindingRequest, parseBindingResponse, JevBindingProvider } from '../src/providers/jev.js';
import type { BindingRequest } from '../src/providers/binding.js';
import type { Observation } from '../src/contracts.js';
import { loadExample, task } from './helpers.js';

function request(): BindingRequest { return { task: task(), observation: loadExample<Observation>('observation'), signal: new AbortController().signal }; }
function answer() { return { model: 'jev-test', answers: { bind_0: { type: 'choice', choice: 'candidate_0', confidence: 0.8, probabilities: { candidate_0: 0.9, need_more_observation: 0.08, none_in_observed_scope: 0.02 } } } }; }
test('compiler sends meanings and visible ancestry but omits input values and fixture oracle', () => {
  const input = request();
  input.observation.nodes.find(n => n.ref === 'node-email')!.value = { status: 'available', value: 'synthetic-current-value-not-for-model' };
  const compiled = compileBindingRequest(input, 'jev-test');
  const wire = JSON.stringify(compiled.request);
  assert.ok(wire.includes('連絡先')); assert.ok(!wire.includes(input.task.inputs['email']!));
  assert.ok(!wire.includes('synthetic-current-value-not-for-model'));
  assert.ok(!wire.includes('dispatchCount')); assert.deepEqual(Object.keys(compiled.request.questions), ['bind_0']);
});
test('ancestor name failures retain their attribute status in model state', () => {
  const input = request(); input.observation.nodes[1]!.name = { status: 'unsupported' };
  const compiled = compileBindingRequest(input, 'jev-test');
  const state = compiled.request.state as { candidates: { ancestors: { name: unknown }[] }[] };
  assert.deepEqual(state.candidates[0]!.ancestors[0]!.name, { status: 'unsupported' });
});
test('parse Jev choice into observation-bound semantic binding', () => {
  const input = request(); const compiled = compileBindingRequest(input, 'jev-test');
  const result = parseBindingResponse(answer(), compiled, input);
  assert.equal(result.batch.bindings[0]?.targetRef, 'node-email');
  assert.equal(result.batch.observationId, input.observation.observationId);
  assert.equal(result.decisions[0]?.providerModel, 'jev-test');
});
test('partial coverage turns observed absence into additional observation', () => {
  const input = request(); input.observation.coverage.status = 'partial'; input.observation.coverage.omittedReasons = ['virtualized'];
  const raw = answer(); raw.answers.bind_0.choice = 'none_in_observed_scope'; raw.answers.bind_0.probabilities = { candidate_0: 0.01, need_more_observation: 0.01, none_in_observed_scope: 0.98 };
  const result = parseBindingResponse(raw, compileBindingRequest(input, 'jev-test'), input);
  assert.equal(result.batch.needMoreObservation, true); assert.equal(result.batch.notFound, false);
});
test('missing questions, unknown options, nonfinite confidence and distributions are rejected', () => {
  const input = request(); const compiled = compileBindingRequest(input, 'jev-test');
  assert.throws(() => parseBindingResponse({ model: 'jev-test', answers: {} }, compiled, input));
  const invalid = answer(); invalid.answers.bind_0.confidence = NaN;
  assert.throws(() => parseBindingResponse(invalid, compiled, input));
  invalid.answers.bind_0.confidence = 0.8; invalid.answers.bind_0.choice = 'invented';
  assert.throws(() => parseBindingResponse(invalid, compiled, input));
});
test('uncalibrated provider cannot advertise executable scope', () => {
  const provider = new JevBindingProvider({ model: 'jev-test', apiKey: 'synthetic-test-value' });
  assert.equal(provider.executionScope, undefined);
});
