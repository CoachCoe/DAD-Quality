import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Run } from '../src/core.js';
import { BenchmarkAdapter } from '../src/benchmark-adapter.js';
import { resolveTarget } from '../src/targets.js';
import { discoveryPolicy } from '../src/discovery-runner.js';

// No model/API key and no Docker: the benchmark adapter provisions an in-process
// loopback HTTP server, so provisioning and the loopback-origin contract can be
// exercised directly without a live model call.
test('benchmark adapter provisions a loopback server, exposes synthetic actors and cleans up', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'atm-benchmark-adapter-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = await Run.create(root, { mode: 'exploration' }, ['discovery']);
  const adapter = new BenchmarkAdapter(run, { signal: new AbortController().signal });
  t.after(() => adapter.app?.close());

  const result = { evidence: [] };
  await adapter.snapshot(result);

  // publicOrigin must satisfy discovery-browser.js's loopback origin check.
  const origin = new URL(adapter.publicOrigin);
  assert.equal(origin.protocol, 'http:');
  assert.equal(origin.hostname, '127.0.0.1');
  assert.ok(origin.port);
  assert.equal(origin.pathname, '/');

  // Server is reachable.
  const response = await fetch(adapter.publicOrigin);
  assert.ok(response.ok);
  await response.body?.cancel();

  // A later lifecycle stage still records its required evidence logs.
  const deployResult = { evidence: [] };
  await adapter.deploy(deployResult);
  assert.ok(deployResult.evidence.some(e => e.path === 'evidence/readiness.log'));

  const actors = adapter.discoveryFixture();
  assert.deepEqual(
    actors.map(a => a.id),
    ['guest', 'donor-a', 'donor-b'],
  );
  const [guest, donorA, donorB] = actors;
  assert.equal(guest.cookie, undefined);
  assert.equal(donorA.cookie, 'test-a');
  assert.equal(donorA.cookieName, 'session');
  assert.equal(donorB.cookie, 'test-b');
  assert.equal(donorB.cookieName, 'session');

  // A replay fixture is available for in-process state inspection.
  assert.equal(typeof adapter.discoveryReplayFixture().inspect, 'function');

  await adapter.cleanup(result);
  await assert.rejects(fetch(adapter.publicOrigin));
});

test('benchmark target resolves to the benchmark adapter and policy identity', () => {
  const target = resolveTarget('benchmark');
  assert.equal(typeof target.adapterFactory, 'function');
  assert.equal(target.policyId, 'benchmark-discovery');
  assert.equal(target.adapterId, 'benchmark');
  const policy = discoveryPolicy('benchmark');
  assert.equal(policy.definition.id, 'benchmark-discovery');
  assert.equal(policy.definition.adapter, 'benchmark');
});
