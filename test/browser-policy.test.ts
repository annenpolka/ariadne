import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateGrant } from '../src/grants.js';
import { browserOrigin, canonicalOrigin, defaultReadLimits, validateReadLimits } from '../src/browser-policy.js';
import { grant } from './helpers.js';
import { validateContract } from '../src/validation.js';
import urlCases from './browser-url-cases.json' with { type: 'json' };

test('URL policy matches the shared native/TypeScript corpus', () => {
  for (const c of urlCases) assert.equal(browserOrigin(c.url) ?? null, c.origin, c.url);
});

const readOnly = () => ({ ...grant(), appId: 'ariadne.chrome', act: false, model: false, allowedCommands: [], allowedActions: [], limits: { maxOperations: 0, maxSemanticRequests: 0, maxObservationExpansions: 0, deadlineMs: 60000 }, pageScope: { origins: ['https://example.org'] }, readLimits: { ...defaultReadLimits } });
test('generic browser grant requires explicit origin scope and forbids Act/Model authority', () => {
  assert.doesNotThrow(() => validateGrant(readOnly()));
  for (const change of [{ read: false }, { act: true }, { model: true }, { allowedCommands: ['set_value'] }, { allowedCommands: ['invoke'] }, { allowedActions: ['fixture.submit'] }, { limits: { ...readOnly().limits, maxOperations: 1 } }, { limits: { ...readOnly().limits, maxSemanticRequests: 1 } }, { pageScope: undefined }, { readLimits: undefined }, { pageScope: { origins: [] } }, { pageScope: { origins: ['https://example.org', 'https://example.org'] } }, { pageScope: { origins: ['https://example.org/'] } }, { pageScope: { origins: ['https://example.org'], extra: true } }]) assert.throws(() => validateGrant({ ...readOnly(), ...change }));
  assert.throws(() => validateGrant({ ...readOnly(), appId: 'ariadne.chrome_fixture' }));
});
test('origin permission retains support for private query/fragment document identity', () => {
  for (const [url, expected] of [
    ['https://EXAMPLE.org/a?private=1#two', 'https://example.org'],
    ['https://example.org:443/x', 'https://example.org'],
    ['https://example.org:8443/x', 'https://example.org:8443'],
    ['http://127.0.0.1:1234/x?a=1#b', 'http://127.0.0.1:1234'],
    ['http://127.0.0.1:80/', 'http://127.0.0.1'],
  ]) assert.equal(browserOrigin(url!), expected);
  for (const url of ['https://u:p@example.org/', 'https://example.org@evil.org/', 'https://example.org\\@evil.org/', 'https://example.org/\n', 'https://example.org/%ZZ', 'https://example.org:0/', 'https://example.org:65536/', 'https://[::1]/', 'https://例.jp/', 'HTTPS://example.org/', 'http://example.org/', 'http://localhost/', 'file:///tmp/test', 'https://example.org.evil/path%']) assert.equal(browserOrigin(url), undefined, url);
  for (const origin of ['https://example.org/', 'https://EXAMPLE.org', 'https://example.org:443', 'https://example.org?q=1']) assert.throws(() => canonicalOrigin(origin));
});
test('read budgets reject empty, fractional, extra and over-limit values without requiring a Task', () => {
  const spec = { kind: 'read_session', schemaVersion: '0.1', readSessionId: 'read-1', scopeRef: 'scope-1', limits: defaultReadLimits };
  assert.doesNotThrow(() => validateContract(spec));
  assert.throws(() => validateContract({ ...spec, slots: [] }));
  const ceiling = { ...defaultReadLimits, maxNodes: 65536, maxBytes: 33554432, maxDepth: 256, maxCaptureMs: 20000 };
  validateReadLimits(ceiling); validateContract({ ...spec, limits: ceiling });
  for (const limits of [{ ...defaultReadLimits, maxNodes: 65537 }, { ...defaultReadLimits, maxBytes: 33554433 }, { ...defaultReadLimits, maxDepth: 257 }, { ...defaultReadLimits, maxCaptureMs: 20001 }, { ...defaultReadLimits, maxCaptures: 0 }, { ...defaultReadLimits, maxCaptureMs: 1.5 }, { ...defaultReadLimits, maxBytes: 8191 }, { ...defaultReadLimits, extra: 1 }]) {
    assert.throws(() => validateReadLimits(limits)); assert.throws(() => validateContract({ ...spec, limits }));
  }
});
