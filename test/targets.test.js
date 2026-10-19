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

// Frozen literals captured from the dev baseline BEFORE any Move 3 edit, via:
//   node -e "import('./src/discovery-runner.js').then(m=>{const d=m.discoveryPolicy('dad');
//     console.log(d.digest);console.log(JSON.stringify(d.definition))})"
// The refactor must not change either value; any drift fails these assertions.
const EXPECTED_DAD_POLICY_DIGEST = 'be91648ac06f7508faf9148c339d25e0a704f4b7c61c7918b8e7b23892113954';
const EXPECTED_DAD_POLICY_JSON =
  '{"schemaVersion":1,"id":"impactgraph-discovery","version":"1.3.0","adapter":"impactgraph","scope":"exploration","checks":[{"id":"snapshot","required":true,"timeoutMs":60000,"evidence":["candidate.json"]},{"id":"docker","required":true,"timeoutMs":30000,"evidence":["docker.log","compose-version.log"]},{"id":"build","required":true,"timeoutMs":1800000,"evidence":["build-api.log","build-web.log"]},{"id":"database","required":true,"timeoutMs":180000,"evidence":["migrations.log","test-migrations.log"]},{"id":"deploy","required":true,"timeoutMs":180000,"evidence":["readiness.log"]},{"id":"discovery","required":true,"timeoutMs":660000,"evidence":["discovery.json","discovery-trace.zip"]},{"id":"cleanup","required":true,"timeoutMs":120000,"evidence":["cleanup.log"]}],"findings":{"blockingSeverities":["unassessed","high","critical"]},"exceptions":{"mode":"disabled"}}';

test('discoveryPolicy(dad) stays byte-identical to the default DAD policy', () => {
  const policy = discoveryPolicy('dad');
  assert.equal(policy.definition.id, 'impactgraph-discovery');
  assert.equal(policy.definition.adapter, 'impactgraph');
  assert.equal(policy.digest, discoveryPolicy().digest);
  // Pinned pre-refactor digest + full JSON snapshot: locks both the canonical
  // hash and the exact definition shape against any Move 3 drift.
  assert.equal(policy.digest, EXPECTED_DAD_POLICY_DIGEST);
  assert.equal(JSON.stringify(policy.definition), EXPECTED_DAD_POLICY_JSON);
});
