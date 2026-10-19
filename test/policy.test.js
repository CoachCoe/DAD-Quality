import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Run, atomicJSON } from '../src/core.js';
import { loadPolicy, hashPolicy, validatePolicy } from '../src/policy.js';
import { discoveryPolicy } from '../src/discovery-runner.js';
import { evaluateRelease, assessRelease } from '../src/release.js';
import { Dashboard } from '../src/dashboard.js';
import { main } from '../src/cli.js';
import { collectFindings, listRuns } from '../src/history.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'atm-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const policy = await loadPolicy();
  const run = await Run.create(
    root,
    { adapter: 'impactgraph' },
    policy.definition.checks.filter(c => c.required).map(c => c.id),
    policy,
  );
  run.data.candidate = {
    revision: 'a'.repeat(40),
    source: '/synthetic/DAD-Main',
    sourceArchiveSha256: 'b'.repeat(64),
    images: { api: `sha256:${'c'.repeat(64)}`, web: `sha256:${'d'.repeat(64)}` },
  };
  for (const check of policy.definition.checks) {
    const evidence = [];
    for (const name of check.evidence) evidence.push(await run.evidence(name, `Synthetic ${name}`));
    run.data.results.push({
      id: check.id,
      required: check.required,
      status: 'passed',
      summary: 'Synthetic pass',
      startedAt: run.data.startedAt,
      finishedAt: run.data.startedAt,
      evidence,
    });
  }
  await run.finish();
  return { root, run, policy };
}

test('policy rejects unsupported handlers, weakened contracts, duplicate checks and exception overrides', async () => {
  const { definition } = await loadPolicy();
  for (const mutate of [
    p => {
      p.checks[0].id = 'shell';
    },
    p => {
      p.checks[0].evidence = [];
    },
    p => {
      p.checks.push(p.checks[0]);
    },
    p => {
      p.checks[0].required = false;
    },
    p => {
      p.checks[0].timeoutMs = -1;
    },
    p => {
      p.checks.find(c => c.scenario).scenario.version = 999;
    },
    p => {
      p.exceptions.mode = 'allow';
    },
    p => {
      p.findings.blockingSeverities = ['high'];
    },
    p => {
      p.scope = 'production';
    },
    p => {
      p.checks[0].command = 'arbitrary';
    },
  ]) {
    const value = structuredClone(definition);
    mutate(value);
    assert.throws(() => validatePolicy(value));
  }
});

test('policy identity accepts any registered adapter but still rejects unregistered ones', () => {
  const base = discoveryPolicy('dad').definition;
  const registered = structuredClone(base);
  registered.adapter = 'impactgraph';
  assert.doesNotThrow(() => validatePolicy(registered));
  const unregistered = structuredClone(base);
  unregistered.adapter = 'unregistered-xyz';
  assert.throws(() => validatePolicy(unregistered), /adapter/);
});

test('effective policy snapshots distinguish advisory and required AI without altering the base file', async () => {
  const original = await loadPolicy(),
    advisory = await loadPolicy(undefined, { ai: true }),
    required = await loadPolicy(undefined, { requireAI: true });
  assert.equal(advisory.definition.checks.find(c => c.id === 'ai-public-journey').required, false);
  assert.equal(required.definition.checks.find(c => c.id === 'ai-public-journey').required, true);
  assert.equal(new Set([original.digest, advisory.digest, required.digest]).size, 3);
  assert.equal((await loadPolicy()).digest, original.digest);
  assert.equal(hashPolicy({ b: 1, a: 2 }), hashPolicy({ a: 2, b: 1 }));
});

test('completed passing policy is eligible locally and assessments are reproducible', async t => {
  const { root, run } = await fixture(t);
  const first = await assessRelease(root, run.data);
  assert.equal(first.eligible, true);
  assert.equal(first.productionAuthorized, false);
  assert.deepEqual(await assessRelease(root, run.data), first);
});

test('incomplete, canceled, forged policy and missing result evidence cannot authorize acceptance', async t => {
  const { run } = await fixture(t);
  for (const mutate of [
    r => {
      delete r.finishedAt;
    },
    r => {
      r.canceledAt = r.startedAt;
    },
    r => {
      r.policy.definition.version = '9.0.0';
    },
    r => {
      r.required.pop();
    },
    r => {
      r.results[0].evidence = [];
    },
    r => {
      delete r.results[0].finishedAt;
    },
    r => {
      r.results.push(r.results[0]);
    },
    r => {
      r.candidate.images = {};
    },
    r => {
      r.policy = { version: 1 };
    },
  ]) {
    const candidate = structuredClone(run.data);
    mutate(candidate);
    assert.equal(evaluateRelease(candidate).eligible, false);
  }
});

test('missing and modified files block reassessment despite a saved passing verdict', async t => {
  const { root, run } = await fixture(t);
  run.data.release = await assessRelease(root, run.data);
  await run.save();
  const report = await readFile(path.join(run.dir, 'run.json'), 'utf8');
  await writeFile(path.join(run.dir, 'evidence/donor-verification.json'), 'changed');
  let assessment = await assessRelease(root, run.data);
  assert.equal(assessment.eligible, false);
  assert.match(assessment.reasons.join('\n'), /changed evidence/);
  await rm(path.join(run.dir, 'evidence/donor-verification.json'));
  assessment = await assessRelease(root, run.data);
  assert.match(assessment.reasons.join('\n'), /missing evidence/);
  assert.equal(await readFile(path.join(run.dir, 'run.json'), 'utf8'), report);
});

test('open findings block only their source; resolution cannot waive a failed check', async t => {
  const { run } = await fixture(t);
  const finding = {
    id: 'e'.repeat(24),
    source: run.data.candidate.source,
    severity: 'high',
    disposition: 'confirmed',
    lastSeen: run.data.startedAt,
  };
  assert.equal(evaluateRelease(run.data, { findings: [finding] }).eligible, false);
  assert.equal(evaluateRelease(run.data, { findings: [{ ...finding, source: '/different/repo' }] }).eligible, true);
  assert.equal(evaluateRelease(run.data, { findings: [{ ...finding, severity: 'unassessed' }] }).eligible, false);
  assert.equal(evaluateRelease(run.data, { findings: [{ ...finding, disposition: 'resolved' }] }).eligible, true);
  run.data.results[0].status = 'failed';
  run.data.results[0].summary = 'Snapshot failed';
  assert.equal(evaluateRelease(run.data, { findings: [{ ...finding, disposition: 'resolved' }] }).eligible, false);
});

test('CLI and dashboard agree on current assessment and leave historical evidence untouched', async t => {
  const { root, run } = await fixture(t);
  run.data.release = await assessRelease(root, run.data);
  await run.save();
  const original = await readFile(path.join(run.dir, 'run.json'), 'utf8');
  const failed = await Run.create(root, { adapter: 'impactgraph' }, ['donor-claim-journey']);
  failed.data.candidate = { ...run.data.candidate };
  failed.data.results = [
    {
      id: 'donor-claim-journey',
      status: 'failed',
      summary: 'Replay allowed',
      finishedAt: new Date().toISOString(),
      evidence: [],
    },
  ];
  await failed.finish();
  const dashboard = new Dashboard({ repo: run.data.candidate.source, root });
  await dashboard.initialize();
  t.after(() => dashboard.close());
  const detail = await dashboard.detail(run.data.id);
  assert.equal(detail.release.eligible, false);
  assert.equal(detail.run.release.eligible, true);
  const stdout = [],
    oldLog = console.log;
  let code;
  try {
    console.log = value => stdout.push(value);
    code = await main(['inspect', path.join(run.dir, 'run.json')]);
  } finally {
    console.log = oldLog;
  }
  assert.equal(code, 3);
  assert.deepEqual(JSON.parse(stdout.join('')).release, detail.release);
  const { runs } = await listRuns(root);
  const [finding] = await collectFindings(root, runs);
  await dashboard.triage(finding.id, {
    disposition: 'resolved',
    severity: 'high',
    note: 'Synthetic regression fixture resolved.',
  });
  assert.equal((await assessRelease(root, run.data)).eligible, true);
  assert.equal(await readFile(path.join(run.dir, 'run.json'), 'utf8'), original);
});

test('corrupt finding state fails closed instead of silently forgetting blockers', async t => {
  const { root, run } = await fixture(t);
  await mkdir(path.join(root, '.dashboard'));
  await atomicJSON(path.join(root, '.dashboard/state.json'), {
    triage: { bad: { disposition: 'resolved', severity: 'critical', note: '' } },
  });
  const result = await assessRelease(root, run.data);
  assert.equal(result.eligible, false);
  assert.match(result.reasons.join('\n'), /Finding assessments/);
});

test('agent hypotheses need human confirmation before affecting an otherwise eligible candidate', async t => {
  const { run } = await fixture(t);
  const hypothesis = {
    id: 'hypothesis',
    source: run.data.candidate.source,
    check: 'discovery',
    severity: 'high',
    disposition: 'untriaged',
    lastSeen: run.data.startedAt,
  };
  assert.equal(evaluateRelease(run.data, { findings: [hypothesis] }).eligible, true);
  assert.equal(evaluateRelease(run.data, { findings: [{ ...hypothesis, disposition: 'confirmed' }] }).eligible, false);
  assert.equal(evaluateRelease(run.data, { findings: [{ ...hypothesis, disposition: 'resolved' }] }).eligible, true);
  assert.equal(evaluateRelease(run.data, { findings: [{ ...hypothesis, check: 'api-tests' }] }).eligible, false);
});
