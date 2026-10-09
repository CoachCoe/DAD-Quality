import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openBrowser } from '../src/browser.js';
import { explore } from '../src/agent.js';

async function server(t, handle) {
  const instance = createServer(handle);
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { instance.closeAllConnections(); instance.close(resolve); }));
  return `http://127.0.0.1:${instance.address().port}`;
}

test('real browser blocks cross-origin requests, redirects and writes', async t => {
  let externalHits = 0, writes = 0;
  const external = await server(t, (_, res) => { externalHits++; res.end('forbidden'); });
  const origin = await server(t, (req, res) => {
    if (req.method === 'POST') writes++;
    if (req.url === '/redirect') { res.writeHead(302, { Location: `${external}/escape` }); res.end(); return; }
    res.setHeader('Content-Type', 'text/html'); res.end('<h1>Synthetic application</h1>');
  });
  const session = await openBrowser([origin], { readOnly: true });
  t.after(session.close);
  const page = await session.newPage();
  await page.goto(origin);
  await page.evaluate(async url => {
    await fetch('/write', { method: 'POST', body: 'synthetic' }).catch(() => {});
    await fetch(url).catch(() => {});
  }, external);
  await page.goto(`${origin}/redirect`).catch(() => {});
  assert.equal(writes, 0);
  assert.equal(externalHits, 0);
  assert.ok(session.blocked.length >= 2);
});

test('browser exploration follows a supplied action and independently verifies resulting DOM', async t => {
  const origin = await server(t, (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(req.url === '/donate' ? '<main><label>Email<input type="email"></label><p>Monthly giving</p></main>' : '<main><a href="/donate">Try giving</a></main>');
  });
  const session = await openBrowser([origin], { readOnly: true });
  t.after(session.close);
  const page = await session.newPage();
  await page.goto(origin);
  let step = 0;
  const result = await explore({
    signal: new AbortController().signal,
    provider: async () => ({ action: step++ === 0 ? { action: 'click', role: 'link', name: 'Try giving' } : { action: 'done', role: 'link', name: '' } }),
    observe: async () => ({ snapshot: await page.locator('body').ariaSnapshot() }),
    act: async action => { await page.getByRole(action.role, { name: action.name, exact: true }).click(); },
    verify: async () => ({ passed: new URL(page.url()).pathname === '/donate' && await page.getByLabel('Email').isVisible() }),
  });
  assert.equal(result.actions, 2);
});
