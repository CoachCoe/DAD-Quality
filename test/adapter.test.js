import test from 'node:test';
import assert from 'node:assert/strict';
import { composeDefinition } from '../src/impactgraph.js';

test('runtime isolates database and disables external integrations', () => {
  const config = composeDefinition({ id: 'atm-test', port: 43123, password: 'owner', apiPassword: 'api', staffPassword: 'staff' });
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
  assert.match(config.services.api.environment.DONOR_API_DATABASE_URL, /\/impactgraph_atm\?/);
});
