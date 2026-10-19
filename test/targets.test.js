import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTarget, isRegisteredAdapter } from '../src/targets/index.js';
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

// Discovery runs record this policy; a changed definition needs a new version.
const EXPECTED_DAD_POLICY_DIGEST = 'be91648ac06f7508faf9148c339d25e0a704f4b7c61c7918b8e7b23892113954';

test('the DAD discovery policy is unchanged unless its version changes', () => {
  const policy = discoveryPolicy('dad');
  assert.equal(policy.definition.version, '1.3.0');
  assert.equal(policy.digest, discoveryPolicy().digest);
  assert.equal(policy.digest, EXPECTED_DAD_POLICY_DIGEST);
});
