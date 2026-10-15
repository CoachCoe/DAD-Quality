import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Run, RunError, digest, evaluate, redact, reportHTML, verifyEvidence } from '../src/core.js';

test('release decisions fail closed for missing, duplicate, empty and invalid checks', () => {
  assert.equal(evaluate(['build'], []).eligible, false);
  assert.equal(evaluate([], []).eligible, false);
  assert.equal(evaluate(['build'], [{ id: 'build', status: 'passed' }, { id: 'build', status: 'passed' }]).eligible, false);
  assert.equal(evaluate(['build'], [{ id: 'build', status: 'unknown' }]).eligible, false);
  assert.equal(evaluate(['build'], [{ id: 'build', status: 'passed' }]).eligible, true);
});

test('advisory findings never change required results; failures take precedence', () => {
  assert.equal(evaluate(['build'], [{ id: 'build', status: 'passed' }, { id: 'ai', status: 'failed' }]).status, 'passed');
  assert.equal(evaluate(['build', 'browser'], [{ id: 'build', status: 'failed' }]).status, 'failed');
  assert.equal(evaluate(['build'], [{ id: 'build', status: 'canceled' }]).status, 'canceled');
});

test('secrets are redacted from text evidence', () => {
  const input = 'postgresql://user:private-password@postgres/db\nhttp://staff.localhost/activate#token=abc-secret\nAuthorization: Bearer hidden\nCookie: session=hidden\nsk-proj-abcdefghijklmnop';
  const output = redact(input);
  for (const secret of ['private-password', 'abc-secret', 'Bearer hidden', 'session=hidden', 'sk-proj-abcdefghijklmnop']) assert.equal(output.includes(secret), false);
});

test('reports escape hostile page content', () => {
  const output = reportHTML({ id: '<img src=x onerror=alert(1)>', startedAt: 'now', results: [{ id: 'browser', status: 'failed', summary: '<script>bad()</script>' }], decision: { status: 'failed', reasons: [] } });
  assert.equal(output.includes('<script>bad()'), false);
  assert.equal(output.includes('&lt;script&gt;'), true);
});

test('run persists failures and verifiable evidence before completion', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'atm-unit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = await Run.create(root, {}, ['browser']);
  assert.equal(await run.step('browser', async result => {
    result.evidence.push(await run.evidence('failure.log', 'token evidence'));
    throw new RunError('Expected a rejection', 'failed');
  }), false);
  await run.finish();
  const manifest = JSON.parse(await readFile(path.join(run.dir, 'run.json')));
  assert.equal(manifest.decision.eligible, false);
  assert.equal(manifest.results[0].status, 'failed');
  const evidence = manifest.results[0].evidence[0];
  assert.equal(evidence.sha256, digest(await readFile(path.join(run.dir, evidence.path))));
  assert.ok(manifest.finishedAt);
  assert.deepEqual(await verifyEvidence(run.dir, manifest), []);
  await writeFile(path.join(run.dir, evidence.path), 'modified after report');
  assert.match((await verifyEvidence(run.dir, manifest))[0], /changed evidence/);
  manifest.results[0].evidence[0].path = '../outside-run';
  assert.match((await verifyEvidence(run.dir, manifest))[0], /invalid evidence path/);
});

test('benchmark and legacy manifests can finish a non-acceptance report without a versioned policy', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'atm-benchmark-report-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = await Run.create(root, { mode: 'exploration' }, ['discovery']);
  await run.step('discovery', async () => ({ status: 'inconclusive', summary: 'Provider unavailable.' }));
  run.data.release = { scope: 'exploration', status: 'not-applicable', eligible: false, productionAuthorized: false, reasons: ['Benchmark only.'] };
  await run.finish();
  assert.match(await readFile(path.join(run.dir, 'report.html'), 'utf8'), /No versioned acceptance policy recorded/);
  assert.equal(run.data.decision.eligible, false);
});
