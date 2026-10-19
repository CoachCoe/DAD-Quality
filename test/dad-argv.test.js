import test from 'node:test';
import assert from 'node:assert/strict';
import { DadAdapter } from '../src/dad.js';

// Byte-identical argv guards for Move 3's adapter split. Each rewritten compose/
// exec call site must emit exactly the pre-refactor argv array. The literals
// below were captured from the dev baseline (the pre-refactor inlined arrays);
// any drift in the composeRun prepend rule or the execSql binding fails loudly.
//
// Capture strategy (no Docker): drive a DadAdapter whose `logged` and `compose`
// are stubbed to record the final argv. composeRun -> logged (captures the full
// ['compose','-p',id,'-f',file, ...REST] array); sql -> execSql -> compose
// (captures the ['exec','-T','postgres','psql', ...] array compose receives).
const ID = 'atm-20260101000000-0a1b2c3d';
const FILE = `/tmp/${ID}/compose.json`;

function stubbedAdapter({ mode = 'acceptance' } = {}) {
  const run = {
    dir: `/tmp/${ID}`,
    data: { id: ID, options: { mode }, candidate: {} },
    async evidence(relative, content) {
      return { path: `evidence/${relative}`, sha256: 'x'.repeat(64), bytes: content.length };
    },
  };
  const adapter = new DadAdapter(run, { repo: '/synthetic' });
  adapter.id = ID;
  adapter.file = FILE;
  // Run-local credentials the rewritten call sites interpolate.
  adapter.password = 'OWNERPW';
  adapter.apiPassword = 'APIPW';
  adapter.staffPassword = 'STAFFPW';
  const logged = [];
  const composed = [];
  adapter.logged = async (_result, label, binary, args, options) => {
    logged.push({ label, binary, args, options });
    return { stdout: '', stderr: '' };
  };
  adapter.compose = (args, options) => {
    composed.push({ args, options });
    return Promise.resolve({ stdout: '', stderr: '' });
  };
  return { adapter, logged, composed };
}

test('database-start emits the pinned compose up argv (acceptance includes test-postgres)', async () => {
  const { adapter, logged } = stubbedAdapter({ mode: 'acceptance' });
  await adapter.database({ evidence: [] });
  const start = logged.find(c => c.label === 'database-start');
  assert.deepEqual(start.args, [
    'compose',
    '-p',
    ID,
    '-f',
    FILE,
    'up',
    '-d',
    '--wait',
    '--wait-timeout',
    '90',
    'postgres',
    'test-postgres',
  ]);
  assert.equal(start.binary, 'docker');
});

test('database-start omits test-postgres under exploration mode', async () => {
  const { adapter, logged } = stubbedAdapter({ mode: 'exploration' });
  await adapter.database({ evidence: [] });
  const start = logged.find(c => c.label === 'database-start');
  assert.deepEqual(start.args, [
    'compose',
    '-p',
    ID,
    '-f',
    FILE,
    'up',
    '-d',
    '--wait',
    '--wait-timeout',
    '90',
    'postgres',
  ]);
});

test('migrations emits the pinned migrate run argv', async () => {
  const { adapter, logged } = stubbedAdapter({ mode: 'acceptance' });
  await adapter.database({ evidence: [] });
  const migrations = logged.find(c => c.label === 'migrations');
  assert.deepEqual(migrations.args, ['compose', '-p', ID, '-f', FILE, 'run', '--rm', '-T', 'migrate']);
  assert.deepEqual(migrations.options, { failureStatus: 'failed' });
});

test('test-migrations (acceptance) emits the pinned argv incl. the templated DONOR_GO_DATABASE_URL', async () => {
  const { adapter, logged } = stubbedAdapter({ mode: 'acceptance' });
  await adapter.database({ evidence: [] });
  const testMigrations = logged.find(c => c.label === 'test-migrations');
  assert.deepEqual(testMigrations.args, [
    'compose',
    '-p',
    ID,
    '-f',
    FILE,
    'run',
    '--rm',
    '-T',
    '-e',
    'DONOR_GO_DATABASE_URL=postgresql://atm_owner:OWNERPW@test-postgres/donor_go?sslmode=disable',
    'migrate',
  ]);
  assert.deepEqual(testMigrations.options, { failureStatus: 'failed' });
});

test('suite(api-tests) and suite(web-tests) emit the pinned run argv', async () => {
  const { adapter, logged } = stubbedAdapter();
  await adapter.suite({ evidence: [] }, 'api-tests');
  await adapter.suite({ evidence: [] }, 'web-tests');
  const api = logged.find(c => c.label === 'api-tests');
  const web = logged.find(c => c.label === 'web-tests');
  assert.deepEqual(api.args, ['compose', '-p', ID, '-f', FILE, 'run', '--rm', '-T', 'api-tests']);
  assert.deepEqual(web.args, ['compose', '-p', ID, '-f', FILE, 'run', '--rm', '-T', 'web-tests']);
  assert.deepEqual(api.options, { timeout: 900_000, failureStatus: 'failed' });
});

test('deploy emits the pinned compose up argv', async () => {
  const { adapter, logged } = stubbedAdapter();
  // deploy performs a readiness compose exec and a real fetch afterwards; stop
  // after the composeRun by making compose throw so we only assert the argv.
  adapter.compose = () => {
    throw new Error('stop-after-composeRun');
  };
  await adapter.deploy({ evidence: [] }).catch(() => {});
  const deploy = logged.find(c => c.label === 'deploy');
  assert.deepEqual(deploy.args, [
    'compose',
    '-p',
    ID,
    '-f',
    FILE,
    'up',
    '-d',
    '--wait',
    '--wait-timeout',
    '120',
    'api',
    'web',
    'ingress',
  ]);
  assert.deepEqual(deploy.options, { timeout: 180_000 });
});

test('cleanup down emits the pinned down argv', async () => {
  const { adapter, logged } = stubbedAdapter();
  adapter.created = true;
  // Swallow the best-effort logs collection; assert only the down argv.
  adapter.compose = () => Promise.resolve({ stdout: '', stderr: '' });
  await adapter.cleanup({ evidence: [] });
  const down = logged.find(c => c.label === 'cleanup');
  assert.deepEqual(down.args, [
    'compose',
    '-p',
    ID,
    '-f',
    FILE,
    'down',
    '--volumes',
    '--remove-orphans',
    '--timeout',
    '10',
  ]);
  assert.deepEqual(down.options, { timeout: 90_000 });
});

test('sql/exec emits the pinned psql argv with load-bearing -X -v ON_ERROR_STOP=1', async () => {
  const { adapter, composed } = stubbedAdapter();
  await adapter.sql('SELECT 1');
  assert.equal(composed.length, 1);
  assert.deepEqual(composed[0].args, [
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
  assert.deepEqual(composed[0].options, { input: 'SELECT 1' });
});
