import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { sourceReader } from '../src/source-reader.js';
import { experimentPlan } from '../src/experiments.js';
import { discover, evaluateExpectation } from '../src/discovery.js';
import { replayFixture } from '../src/discovery-fixture.js';
import { DadAdapter } from '../src/dad.js';
import { benchmarkMetrics } from '../src/discovery-benchmark.js';

const action = (kind, fields = {}) => ({
  action: kind,
  target: '',
  value: '',
  title: '',
  reason: 'Check observed behavior',
  expectation: '',
  text: '',
  ...fields,
});
const plan = {
  capability: 'Profile',
  behavior: 'Persistence',
  state: 'Valid name',
  preconditions: 'Signed-in donor',
  expected: 'Saved name survives reload',
  basis: 'documented',
  references: ['docs/profile.md'],
  checks: [
    { id: 'reload', kind: 'action', action: 'reload', actor: 'a', target: '', value: '' },
    {
      id: 'name',
      kind: 'assertion',
      expectation: 'text_present',
      actor: 'a',
      target: '',
      value: '',
      text: 'Alex',
      baseline: '',
    },
  ],
};

test('source inspection is bounded, literal, cited and excludes secrets, binary files and symlinks', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'atm-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'docs'));
  await mkdir(path.join(root, '.git'));
  await writeFile(path.join(root, 'docs/profile.md'), `Names persist\n${'safe\n'.repeat(150)}`);
  await writeFile(path.join(root, '.env'), 'SECRET=secret');
  await writeFile(path.join(root, '.git/config'), 'secret');
  await writeFile(path.join(root, 'binary.js'), Buffer.from([0, 1]));
  await symlink('/etc/passwd', path.join(root, 'escape.js'));
  const source = await sourceReader(root);
  assert.deepEqual(source.inventory, ['binary.js', 'docs/profile.md']);
  const read = await source.act(action('read_source', { target: 'docs/profile.md' }));
  assert.equal(read.end, 100);
  assert.match(read.text, /^1: Names persist/);
  assert.match(read.sha256, /^[a-f0-9]{64}$/);
  const found = await source.act(action('search_source', { value: 'Names persist' }));
  assert.equal(found.matches[0].line, 1);
  for (const target of ['../etc/passwd', '/etc/passwd', '.env', 'escape.js', 'binary.js'])
    await assert.rejects(source.act(action('read_source', { target })));
  await assert.rejects(source.act(action('read_source', { target: 'docs/profile.md', value: '-1' })));
  await rm(path.join(root, 'docs/profile.md'));
  await symlink('/etc/passwd', path.join(root, 'docs/profile.md'));
  await assert.rejects(source.act(action('read_source', { target: 'docs/profile.md' })));
});

test('structured plans distinguish requirements, implementation and assumptions and require read citations', () => {
  assert.throws(
    () => experimentPlan(action('investigate', { value: JSON.stringify(plan) }), { actor: 'a' }),
    /already read/,
  );
  const parsed = experimentPlan(action('investigate', { value: JSON.stringify(plan) }), { actor: 'a' }, [
    { result: { path: 'docs/profile.md' } },
  ]);
  assert.equal(parsed.actor, 'a');
  assert.equal(parsed.basis, 'documented');
  assert.throws(
    () => experimentPlan(action('investigate', { value: JSON.stringify({ ...plan, basis: 'certain' }) }), {}),
    /basis/,
  );
});

test('typed assertions inspect captured fields, paths and approved independent state without inventing missing values', () => {
  const observation = {
    id: 'o1',
    text: '',
    path: '/profile',
    controls: [{ id: 'c1', value: 'Alex', checked: false }],
    state: { a: { public_name: 'Alex', enabled: false } },
  };
  for (const fields of [
    { expectation: 'field_value', target: 'c1', text: 'Alex' },
    { expectation: 'field_checked', target: 'c1', text: 'false' },
    { expectation: 'path_equals', text: '/profile' },
    { expectation: 'state_equals', target: 'a', value: 'public_name', text: 'Alex' },
  ])
    assert.equal(evaluateExpectation(action('assert', fields), observation).passed, true);
  assert.equal(
    evaluateExpectation(action('assert', { expectation: 'state_equals', target: 'a', value: 'secret' }), observation)
      .evaluable,
    false,
  );
  assert.equal(
    evaluateExpectation(action('assert', { expectation: 'field_checked', target: 'c1', text: 'maybe' }), observation)
      .evaluable,
    false,
  );
});

test('experiments cannot conclude tested behavior without actions and assertions; unfinished plans cannot finish', async () => {
  const report = { requests: 0, tokens: 0, pages: [], investigations: [], observations: [], events: [], findings: [] };
  const decisions = [
    action('investigate', {
      title: 'Persistence',
      value: JSON.stringify({ ...plan, basis: 'observed', references: [] }),
    }),
    action('conclude', { value: 'supported' }),
    action('finish'),
    action('reload'),
    action('verify', { target: 'name' }),
    action('conclude', { value: 'supported' }),
    action('finish'),
  ];
  await discover({
    provider: async () => ({ action: decisions.shift(), tokens: 1 }),
    browser: {
      observe: async () => ({ id: 'o1', actor: 'a', text: 'Alex', path: '/', textTruncated: false }),
      pages: () => [],
      act: async () => {},
    },
    report,
    signal: new AbortController().signal,
  });
  assert.match(report.events[1].outcome, /requires/);
  assert.match(report.events[2].outcome, /before finishing/);
  assert.equal(report.status, 'completed');
  assert.equal(report.coverage.experiments[0].status, 'supported');
  assert.equal(report.assertions.length, 1);
});

test('clean fixture replay restores current state on success and on failed baseline installation', async () => {
  let state = { name: 'initial' },
    stopped = false,
    fail = false;
  const fixture = await replayFixture({
    snapshot: async () => structuredClone(state),
    restore: async value => {
      if (fail && value.name === 'initial') throw new Error('restore refused');
      state = structuredClone(value);
    },
    stop: async () => {
      stopped = true;
    },
    start: async () => {
      stopped = false;
    },
  });
  state.name = 'working';
  const restore = await fixture.replay();
  assert.equal(state.name, 'initial');
  await assert.rejects(fixture.replay(), /already active/);
  state.name = 'replay';
  await restore();
  assert.equal(state.name, 'working');
  assert.equal(stopped, false);
  fail = true;
  await assert.rejects(fixture.replay(), /restore refused/);
  assert.equal(state.name, 'working');
  assert.equal(stopped, false);
});

test('DAD adapter verifier selects only synthetic identities and replay refuses other database contexts', async () => {
  const adapter = new DadAdapter({ data: { id: 'unsafe', options: {} }, dir: '/tmp/fixture' }, { repo: '/app' });
  adapter.sql = async sql => {
    assert.match(sql, /^BEGIN READ ONLY;/);
    assert.match(sql, /explorer-a@atm.invalid/);
    assert.doesNotMatch(sql, /token_hash/);
    return { stdout: '{"donor-a":{"public_name":null}}' };
  };
  assert.equal((await adapter.discoveryState())['donor-a'].public_name, null);
  await assert.rejects(adapter.discoveryReplayFixture(), /run-owned/);
});

test('benchmark keeps incomplete attempts in detection denominator and distinguishes healthy false positives', () => {
  const metrics = benchmarkMetrics([
    { fault: 'lost-save', verifiedFindings: 1, findings: 1, tokens: 100, requests: 5, status: 'completed' },
    { fault: 'cross-actor', verifiedFindings: 0, findings: 0, tokens: 50, requests: 3, status: 'inconclusive' },
    { fault: 'healthy', verifiedFindings: 0, findings: 1, tokens: 50, requests: 4, status: 'completed' },
  ]);
  assert.equal(metrics.detectionRate, 0.5);
  assert.equal(metrics.healthyFalsePositiveRunRate, 1);
  assert.equal(metrics.tokensPerDetectedCase, 200);
});
