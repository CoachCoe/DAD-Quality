import test from 'node:test';
import assert from 'node:assert/strict';
import { ProvisioningAdapter } from '../src/targets/base.js';

// In-memory Run double: records every evidence write as { relative, content }
// without touching the filesystem, mirroring the real run.evidence(name, text)
// return shape (a reference object the phase result collects).
function fakeRun(id = 'atm-base-test') {
  const writes = [];
  return {
    writes,
    dir: '/tmp/atm-base-test',
    data: { id },
    async evidence(relative, content) {
      writes.push({ relative, content });
      return { path: `evidence/${relative}`, sha256: 'x'.repeat(64), bytes: content.length };
    },
  };
}

test('logged writes the label.log evidence on success and appends the reference', async () => {
  const run = fakeRun();
  const adapter = new ProvisioningAdapter(run);
  const result = { evidence: [] };
  // Fake command: a trivial cross-platform process that succeeds with output.
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
  const adapter = new ProvisioningAdapter(run);
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

test('composeRun prepends exactly [compose, -p, id, -f, file] then appends args verbatim', async () => {
  const run = fakeRun('atm-run-123');
  const adapter = new ProvisioningAdapter(run);
  adapter.file = '/tmp/atm-run-123/compose.json';
  let captured;
  // Stub logged to capture the flattened argv composeRun hands it.
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

test('execSql emits the pinned psql argv with only service/user/db parameterized', async () => {
  const run = fakeRun('atm-run-456');
  const adapter = new ProvisioningAdapter(run);
  adapter.file = '/tmp/atm-run-456/compose.json';
  let captured;
  // Stub compose to capture the exec argv and options execSql produces.
  adapter.compose = (args, options) => {
    captured = { args, options };
    return Promise.resolve({ stdout: '', stderr: '' });
  };
  await adapter.execSql({ service: 'postgres', user: 'atm_owner', db: 'dad_atm' }, 'SELECT 1;');
  assert.deepEqual(captured.args, [
    'exec',
    '-T',
    'postgres',
    'psql',
    '-X',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    'atm_owner',
    '-d',
    'dad_atm',
    '-At',
  ]);
  assert.deepEqual(captured.options, { input: 'SELECT 1;' });
});
