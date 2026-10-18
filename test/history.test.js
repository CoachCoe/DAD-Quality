import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Run, RunError } from '../src/core.js';
import { collectFindings, readRun } from '../src/history.js';

test('a recurrence reopens either closure without changing its assessment audit or original result', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'atm-recurrence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = await Run.create(root, {}, ['api-tests']);
  run.data.startedAt = '2026-10-17T12:00:00.000Z';
  run.data.candidate = { source: 'github:example/DAD-Main' };
  await run.step('api-tests', async () => { throw new RunError('Authorization regression', 'failed'); });
  run.data.results[0].finishedAt = '2026-10-17T12:01:00.000Z';
  await run.finish();
  const [finding] = await collectFindings(root, [run.data]);
  for (const disposition of ['resolved', 'dismissed']) {
    const audit = [{ disposition, note: 'Reviewed previous occurrence.' }];
    const saved = { disposition, severity: 'high', updatedAt: '2026-10-17T11:00:00.000Z', audit };
    const [reopened] = await collectFindings(root, [run.data], { [finding.id]: saved });
    assert.equal(reopened.disposition, 'reopened');
    assert.equal(reopened.severity, 'high');
    assert.deepEqual(reopened.audit, audit);
    assert.equal(saved.disposition, disposition);
    const [reviewed] = await collectFindings(root, [run.data], { [finding.id]: { ...saved, updatedAt: '2026-10-17T13:00:00.000Z' } });
    assert.equal(reviewed.disposition, disposition);
  }
  assert.equal((await readRun(root, run.data.id)).results[0].status, 'failed');
});

test('triage during a run does not close a failure that finishes after the review', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'atm-active-recurrence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = await Run.create(root, {}, ['api-tests']);
  run.data.startedAt = '2026-10-17T12:00:00.000Z';
  run.data.candidate = { source: 'github:example/DAD-Main' };
  await run.step('api-tests', async () => { throw new RunError('Authorization regression', 'failed'); });
  run.data.results[0].finishedAt = '2026-10-17T12:10:00.000Z';
  await run.finish();
  const [finding] = await collectFindings(root, [run.data]);
  for (const disposition of ['resolved', 'dismissed']) {
    const review = { disposition, severity: 'high', updatedAt: '2026-10-17T12:05:00.000Z', note: 'Reviewed the older occurrence.' };
    const [reopened] = await collectFindings(root, [run.data], { [finding.id]: review });
    assert.equal(reopened.disposition, 'reopened');
    assert.equal(reopened.severity, 'high');
    assert.equal(review.disposition, disposition);
    const [reviewed] = await collectFindings(root, [run.data], { [finding.id]: { ...review, updatedAt: '2026-10-17T12:15:00.000Z' } });
    assert.equal(reviewed.disposition, disposition);
  }
  assert.equal((await readRun(root, run.data.id)).results[0].status, 'failed');
});
