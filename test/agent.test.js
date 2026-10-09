import test from 'node:test';
import assert from 'node:assert/strict';
import { explore, openAIProvider, validateAction } from '../src/agent.js';
import { allowedRequest } from '../src/browser.js';

const action = { action: 'done', role: 'link', name: '' };
const base = { provider: async () => ({ action }), observe: async () => ({}), act: async () => {}, signal: new AbortController().signal };

test('agent assertion of success cannot override independent verification', async () => {
  await assert.rejects(explore({ ...base, verify: async () => ({ passed: false }) }), e => e.status === 'failed');
  assert.equal((await explore({ ...base, verify: async () => ({ passed: true }) })).actions, 1);
});

test('agent action budget terminates loops as inconclusive', async () => {
  let attempts = 0;
  await assert.rejects(explore({ ...base, maxActions: 2, provider: async () => ({ action: { action: 'click', role: 'link', name: 'Missing' } }), act: async () => { attempts++; throw new Error('Missing element'); }, verify: async () => ({ passed: true }) }), e => e.status === 'inconclusive');
  assert.equal(attempts, 2);
});

test('unknown or oversized model actions are rejected', () => {
  for (const value of [{ ...action, action: 'eval' }, { ...action, code: 'process.exit()' }, { ...action, name: 'a'.repeat(201) }, null]) assert.throws(() => validateAction(value));
});

test('network policy checks exact origins, credentials, methods and schemes', () => {
  const origins = ['http://localhost:43210'];
  assert.equal(allowedRequest('http://localhost:43210/donate', 'GET', origins, true), true);
  for (const url of ['http://localhost:3000', 'http://localhost.evil.test:43210', 'file:///etc/passwd', 'http://user:secret@localhost:43210', 'https://localhost:43210']) assert.equal(allowedRequest(url, 'GET', origins, true), false);
  assert.equal(allowedRequest(origins[0], 'POST', origins, true), false);
});

test('provider validates response and sends only bounded tool requests', async () => {
  let payload;
  const provider = openAIProvider({ apiKey: 'test-only', model: 'test-model', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    payload = JSON.parse(options.body);
    return { ok: true, json: async () => ({ status: 'completed', output: [{ type: 'function_call', name: 'browser_action', arguments: JSON.stringify(action) }] }) };
  } });
  assert.deepEqual((await provider({ observation: {}, history: [], signal: base.signal })).action, action);
  assert.equal(payload.store, false);
  assert.equal(payload.parallel_tool_calls, false);
  assert.equal(payload.max_output_tokens, 800);
  assert.equal(payload.tools[0].strict, true);
});

test('provider errors do not echo secrets or become passes', async () => {
  const provider = openAIProvider({ apiKey: 'secret', model: 'test-model', fetchImpl: async () => ({ ok: false, status: 401 }) });
  await assert.rejects(provider({ observation: {}, history: [], signal: base.signal }), e => e.status === 'inconclusive' && !e.message.includes('secret'));
  assert.throws(() => openAIProvider({ model: 'test-model' }));
});
