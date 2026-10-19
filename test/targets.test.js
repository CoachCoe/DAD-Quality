import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTarget, isRegisteredAdapter } from '../src/targets.js';
import { discoveryPolicy } from '../src/discovery-runner.js';

test('the registry resolves dad to its retained impactgraph identity and rejects unknown targets', () => {
  const dad = resolveTarget('dad');
  assert.equal(typeof dad.adapterFactory, 'function');
  assert.equal(dad.policyId, 'impactgraph-discovery');
  assert.equal(dad.adapterId, 'impactgraph');
  assert.deepEqual(resolveTarget(), dad);
  assert.throws(() => resolveTarget('nope'), /Unknown target: nope/);
  assert.equal(isRegisteredAdapter('impactgraph'), true);
  assert.equal(isRegisteredAdapter('bogus'), false);
});

test('discoveryPolicy(dad) stays byte-identical to the default DAD policy', () => {
  const policy = discoveryPolicy('dad');
  assert.equal(policy.definition.id, 'impactgraph-discovery');
  assert.equal(policy.definition.adapter, 'impactgraph');
  assert.equal(policy.digest, discoveryPolicy().digest);
});
