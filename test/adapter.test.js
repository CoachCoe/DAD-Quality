import test from 'node:test';
import assert from 'node:assert/strict';
import { composeDefinition, DadAdapter } from '../src/dad.js';

test('runtime isolates database and disables external integrations', () => {
  const config = composeDefinition({
    id: 'atm-test',
    port: 43123,
    password: 'owner',
    apiPassword: 'api',
    staffPassword: 'staff',
  });
  assert.equal(config.networks.isolated.internal, true);
  assert.equal(config.services.postgres.ports, undefined);
  assert.equal(config.services['test-postgres'].ports, undefined);
  assert.equal(config.services.web.ports, undefined);
  assert.deepEqual(config.services.ingress.ports, ['127.0.0.1:43123:8080']);
  for (const service of Object.values(config.services)) {
    assert.equal(service.env_file, undefined);
    assert.equal(service.environment?.STRIPE_SECRET_KEY, undefined);
    assert.equal(service.environment?.DONOR_SMTP_HOST, undefined);
  }
  assert.equal(config.services.api.environment.DONOR_GO_DATABASE_URL, undefined);
  assert.equal(config.services.api.environment.DONOR_ALLOW_OWNER_CONNECTION, undefined);
  assert.match(config.services['api-tests'].environment.TEST_DATABASE_URL, /\/donor_go\?/);
  assert.match(config.services['api-tests'].environment.TEST_DATABASE_URL, /@test-postgres\//);
  assert.match(config.services.api.environment.DONOR_API_DATABASE_URL, /\/dad_atm\?/);
});

test('donor verifier rejects extra sessions, unconsumed links and changes to another donor', async () => {
  const adapter = new DadAdapter({ data: { id: 'fixture' }, dir: '/tmp/fixture' }, { repo: '/synthetic' });
  const good = {
    claimed: 1,
    consumed_links: 2,
    sessions: 1,
    active_sessions: 1,
    revoked_sessions: 0,
    other_claimed: 0,
    other_sessions: 0,
  };
  let state = good;
  adapter.sql = async query => {
    assert.match(query, /^BEGIN READ ONLY;/);
    assert.match(query, /ROLLBACK;/);
    return { stdout: `BEGIN\n${JSON.stringify(state)}\nROLLBACK` };
  };
  assert.deepEqual(await adapter.verifyDonor(), good);
  for (const [key, value] of [
    ['claimed', 0],
    ['consumed_links', 1],
    ['sessions', 2],
    ['active_sessions', 0],
    ['other_claimed', 1],
    ['other_sessions', 1],
  ]) {
    state = { ...good, [key]: value };
    await assert.rejects(adapter.verifyDonor(), error => error.status === 'failed');
  }
  state = { ...good, active_sessions: 0, revoked_sessions: 1 };
  await adapter.verifyDonor({ signedOut: true });
  state = good;
  await assert.rejects(adapter.verifyDonor({ signedOut: true }), error => error.status === 'failed');
});

test('discovery fixture authenticates donors with the dad_donor_session cookie name', async () => {
  const adapter = new DadAdapter({ data: { id: 'fixture' }, dir: '/tmp/fixture' }, { repo: '/synthetic' });
  adapter.sql = async () => ({ stdout: '' });
  const actors = await adapter.discoveryFixture();
  const authenticated = actors.filter(a => a.cookie);
  assert.equal(authenticated.length, 2);
  for (const actor of authenticated) assert.equal(actor.cookieName, 'dad_donor_session');
  assert.equal(actors.find(a => a.id === 'guest').cookieName, undefined);
});
