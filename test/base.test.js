import test from 'node:test';
import assert from 'node:assert/strict';
import { ProvisioningAdapter } from '../src/targets/base.js';

function fakeRun(id = 'atm-base-test') {
  const writes = [];
  return {
    writes,
    dir: `/tmp/${id}`,
    data: { id },
    async evidence(relative, content) {
      writes.push({ relative, content });
      return { path: `evidence/${relative}`, sha256: 'x'.repeat(64), bytes: content.length };
    },
  };
}

test('logged writes the label.log evidence on success and appends the reference', async () => {
  const run = fakeRun();
  const adapter = new ProvisioningAdapter(run, { repo: '/synthetic' });
  const result = { evidence: [] };
  const output = await adapter.logged(result, 'phase', process.execPath, ['-e', 'process.stdout.write("ok")']);
  assert.equal(output.stdout, 'ok');
  assert.equal(run.writes.length, 1);
  assert.equal(run.writes[0].relative, 'phase.log');
  assert.equal(run.writes[0].content, 'ok');
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].path, 'evidence/phase.log');
});

test('logged still writes the label.log evidence on failure and rethrows', async () => {
  const run = fakeRun();
  const adapter = new ProvisioningAdapter(run, { repo: '/synthetic' });
  const result = { evidence: [] };
  await assert.rejects(
    adapter.logged(result, 'broken', process.execPath, ['-e', 'process.stderr.write("boom");process.exit(1)']),
  );
  assert.equal(run.writes.length, 1);
  assert.equal(run.writes[0].relative, 'broken.log');
  assert.match(run.writes[0].content, /boom/);
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].path, 'evidence/broken.log');
});

test('compose commands are always scoped to the run-owned project and file', async () => {
  const run = fakeRun('atm-run-123');
  const adapter = new ProvisioningAdapter(run, { repo: '/synthetic' });
  let captured;
  adapter.logged = async (result, label, binary, args, options) => {
    captured = { result, label, binary, args, options };
    return { stdout: '', stderr: '' };
  };
  const result = { evidence: [] };
  const opts = { failureStatus: 'failed' };
  await adapter.composeRun(result, 'database-start', ['up', '-d', '--wait', 'postgres'], opts);
  assert.equal(captured.label, 'database-start');
  assert.equal(captured.binary, 'docker');
  assert.deepEqual(captured.args, [
    'compose',
    '-p',
    'atm-run-123',
    '-f',
    '/tmp/atm-run-123/compose.json',
    'up',
    '-d',
    '--wait',
    'postgres',
  ]);
  assert.equal(captured.options, opts);
  assert.equal(captured.result, result);
});
