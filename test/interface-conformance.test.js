import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTarget } from '../src/targets.js';
import { BenchmarkAdapter } from '../src/benchmark-adapter.js';

// Two-adapter conformance proof for the formal discovery target-adapter
// interface (design §1/§6): dad (Docker/Postgres) and benchmark (in-process, no
// Docker) must both expose the required surface the runner consumes, with the
// optional members either absent or of the right kind. No infra needed.
const REQUIRED_METHODS = ['snapshot', 'docker', 'build', 'database', 'deploy', 'discoveryFixture', 'cleanup'];

function fakeRun(id = 'atm-conformance') {
  return { dir: `/tmp/${id}`, data: { id, options: { mode: 'exploration' } } };
}

function assertConforms(adapter) {
  for (const method of REQUIRED_METHODS)
    assert.equal(typeof adapter[method], 'function', `missing required method ${method}`);
  // publicOrigin / signal are writable fields the runner assigns per phase.
  adapter.publicOrigin = 'http://127.0.0.1:12345/';
  assert.equal(adapter.publicOrigin, 'http://127.0.0.1:12345/');
  const signal = new AbortController().signal;
  adapter.signal = signal;
  assert.equal(adapter.signal, signal);
  // Optional members: absent, or a function / string respectively.
  if ('discoveryReplayFixture' in adapter)
    assert.equal(typeof adapter.discoveryReplayFixture, 'function', 'discoveryReplayFixture must be a function');
  if (adapter.source !== undefined) assert.equal(typeof adapter.source, 'string', 'source must be a string path');
}

test('the dad adapter satisfies the formal target-adapter interface', () => {
  const adapter = resolveTarget('dad').adapterFactory(fakeRun('atm-dad-conformance'), { repo: '/synthetic' });
  assertConforms(adapter);
});

test('the benchmark adapter satisfies the formal target-adapter interface', () => {
  const adapter = new BenchmarkAdapter(fakeRun('atm-benchmark-conformance'), { signal: new AbortController().signal });
  assertConforms(adapter);
});
