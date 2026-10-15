import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ImpactGraph, composeDefinition } from '../src/impactgraph.js';

// Explicit Docker integration: no published ports, mounts, or existing databases.
test('PostgreSQL fixture replay restores data and application grants, then restores the working state', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'atm-fixture-postgres-'));
  const id = `atm-20261015000000-${randomUUID().slice(0, 8)}`;
  const adapter = new ImpactGraph({ dir, data: { id, options: { mode: 'exploration' } } }, { repo: dir, signal: AbortSignal.timeout(120_000) });
  const config = composeDefinition({ id, port: 43123, password: 'synthetic', apiPassword: 'synthetic', staffPassword: 'synthetic' });
  const image = config.services.postgres.image;
  const proxyImage = config.services.ingress.image;
  const healthcheck = { test: ['CMD', 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1:3000/'], interval: '1s', timeout: '2s', retries: 30 };
  const nginx = config => ['sh', '-c', `printf '%s' '${config}' > /etc/nginx/conf.d/default.conf; exec nginx -g 'daemon off;'`];
  config.services = {
    postgres: config.services.postgres,
    api: { image, command: ['sleep', 'infinity'], networks: ['isolated'] },
    web: { image: proxyImage, networks: ['isolated'], command: nginx('server { listen 3000; location / { return 200 "ready"; } }'), healthcheck },
    ingress: { image: proxyImage, networks: ['isolated'], command: nginx('server { listen 3000; location / { proxy_pass http://web:3000; } }'), healthcheck },
  };
  const throughIngress = async () => assert.match((await adapter.compose(['exec', '-T', 'ingress', 'wget', '-q', '-O', '-', 'http://127.0.0.1:3000/'])).stdout, /ready/);
  await writeFile(adapter.file, JSON.stringify(config), { mode: 0o600 });
  t.after(async () => { adapter.signal = AbortSignal.timeout(60_000); try { await adapter.compose(['down', '--volumes', '--remove-orphans']); } finally { await rm(dir, { recursive: true, force: true }); } });
  await adapter.compose(['up', '-d', '--wait', '--wait-timeout', '60']); adapter.created = true;
  await adapter.sql(`CREATE ROLE atm_api; CREATE TABLE profiles(name text); INSERT INTO profiles VALUES ('initial'); GRANT SELECT ON profiles TO atm_api;`);
  await adapter.sql(`CREATE TABLE donors(id text, email text, public_name text);
CREATE TABLE donor_preferences(donor_id text, referral_emails boolean, marketing_emails boolean, version integer);
CREATE TABLE donor_gifts(donor_id text);
CREATE TABLE donor_sessions(donor_id text, revoked_at timestamptz, expires_at timestamptz);
INSERT INTO donors VALUES ('a','explorer-a@atm.invalid','Alex'),('b','explorer-b@atm.invalid','Blair'),('c','real@example.invalid','Excluded');
INSERT INTO donor_preferences VALUES ('a',true,false,2);
INSERT INTO donor_gifts VALUES ('a');
INSERT INTO donor_sessions VALUES ('a',NULL,now()+interval '1 hour');`);
  const state = await adapter.discoveryState();
  assert.deepEqual(Object.keys(state).sort(), ['donor-a', 'donor-b']);
  assert.equal(state['donor-a'].public_name, 'Alex'); assert.equal(state['donor-a'].preferences_version, 2);
  assert.equal(state['donor-b'].referral_emails, false); assert.equal(state['donor-a'].active_sessions, 1);
  await throughIngress();
  const fixture = await adapter.discoveryReplayFixture();
  await throughIngress();
  await adapter.sql("UPDATE profiles SET name='working';");
  const restore = await fixture.replay();
  await throughIngress();
  assert.match((await adapter.sql('SELECT name FROM profiles;')).stdout, /initial/);
  assert.match((await adapter.sql("SET ROLE atm_api; SELECT name FROM profiles;")).stdout, /initial/);
  await adapter.sql("UPDATE profiles SET name='replay';");
  await restore();
  await throughIngress();
  assert.match((await adapter.sql('SELECT name FROM profiles;')).stdout, /working/);
});
