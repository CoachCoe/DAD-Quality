import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { openDiscoveryBrowser } from '../src/discovery-browser.js';
import { discover } from '../src/discovery.js';
import { Run } from '../src/core.js';
import { discoveryPolicy } from '../src/discovery-runner.js';
import { createDashboardServer } from '../src/dashboard.js';

const action = (kind, fields = {}) => ({ action: kind, target: '', value: '', title: '', reason: 'Investigate what the observed interface promises.', expectation: '', text: '', ...fields });
const signal = new AbortController().signal;
async function fixture(t) {
  let mutations = 0;
  const server = createServer((request, response) => {
    if (request.url === '/write') { mutations++; response.end('saved'); return; }
    response.setHeader('Content-Type', 'text/html');
    const who = request.headers.cookie?.includes('test-a') ? 'Donor A' : request.headers.cookie?.includes('test-b') ? 'Donor B' : 'Guest';
    if (request.url === '/broken') { response.statusCode = 500; response.end('<html lang="en"><title>Failed</title><body><h1>Unexpected service failure</h1></body></html>'); return; }
    response.end(`<html lang="en"><title>Application</title><body><h1>${who}</h1><a href="/broken">Browse catalog</a><a href="http://example.invalid/">External</a><label>Search<input name="search"></label><button onclick="fetch('/write',{method:'POST'})">Save</button></body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, mutations: () => mutations };
}
const actors = [{ id: 'guest', description: 'Guest', entry: '/' }, { id: 'donor-a', description: 'Synthetic donor A', entry: '/', cookie: 'test-a' }, { id: 'donor-b', description: 'Synthetic donor B', entry: '/', cookie: 'test-b' }];

test('discovery browser maps observed controls, isolates actors, reproduces a server defect and prevents arbitrary navigation', async t => {
  const app = await fixture(t);
  const browser = await openDiscoveryBrowser({ origin: app.origin, actors, signal });
  t.after(() => browser.close());
  let observation = await browser.observe();
  assert.match(observation.text, /Guest/);
  assert.equal(JSON.stringify(observation).includes('test-a'), false);
  assert.ok(observation.pages.some(p => p.path === '/broken'));
  await assert.rejects(browser.act(action('navigate', { target: 'http://example.invalid' })), /discovered page/);
  await assert.rejects(browser.act(action('click', { target: observation.controls.find(c => c.label === 'External').id })), /outside/);
  await browser.act(action('switch_actor', { target: 'donor-a' }));
  observation = await browser.observe(); assert.match(observation.text, /Donor A/);
  await browser.act(action('switch_actor', { target: 'donor-b' }));
  observation = await browser.observe(); assert.match(observation.text, /Donor B/); assert.doesNotMatch(observation.text, /Donor A/);
  await browser.act(action('click', { target: observation.controls.find(c => c.label === 'Browse catalog').id }));
  observation = await browser.observe(); assert.equal(observation.serverErrors[0].status, 500);
  const replay = await browser.reproduce(action('report', { expectation: 'no_server_error', title: 'Catalog fails' }));
  assert.equal(replay.status, 'reproduced'); assert.equal(replay.observation.serverErrors[0].status, 500);
  assert.equal(replay.steps.length, 1);
});

test('mutating experiments retain observations but are never automatically replayed', async t => {
  const app = await fixture(t);
  const browser = await openDiscoveryBrowser({ origin: app.origin, actors, signal });
  t.after(() => browser.close());
  let observation = await browser.observe();
  await browser.act(action('fill', { target: observation.controls.find(c => c.label === 'Search').id, value: 'synthetic input' }));
  observation = await browser.observe();
  assert.equal(observation.controls.find(c => c.label === 'Search').value, 'synthetic input');
  await browser.act(action('click', { target: observation.controls.find(c => c.label === 'Save').id }));
  const replay = await browser.reproduce(action('report', { expectation: 'text_present', text: 'Saved', title: 'No confirmation' }));
  assert.equal(replay.status, 'inconclusive'); assert.match(replay.reason, /mutation/);
  assert.equal(app.mutations(), 1);
});

test('discovery loop records a defect in real browser evidence and dashboard exposes hypotheses, memory and integrity', async t => {
  const app = await fixture(t);
  const root = await mkdtemp(path.join(os.tmpdir(), 'atm-discovery-ui-'));
  const run = await Run.create(root, { adapter: 'impactgraph', mode: 'exploration' }, ['discovery'], discoveryPolicy());
  run.data.candidate = { source: '/synthetic', revision: 'a'.repeat(40) };
  const report = { version: 1, runId: run.data.id, ...run.data.candidate, status: 'running', requests: 0, tokens: 0, pages: [], events: [], observations: [], investigations: [], findings: [], memory: [], warnings: [] };
  await run.step('discovery', async result => {
    const browser = await openDiscoveryBrowser({ origin: app.origin, actors, signal, run, result });
    try {
      // This controlled provider tests the harness, not live-model intelligence.
      let step = 0;
      const provider = async ({ observation }) => ({ tokens: 10, action: [
        () => action('investigate', { title: 'Explore catalog', reason: 'The observed catalog link promises a browsable destination.' }),
        () => action('click', { target: observation.controls.find(c => c.label === 'Browse catalog').id }),
        () => action('report', { title: 'Catalog returns server failure', expectation: 'no_server_error' }),
        () => action('finish', { reason: 'Catalog failure reproduced; other areas remain unexplored.' }),
      ][step++]() });
      await discover({ provider, browser, report, signal });
    } finally { await browser.close(); }
    result.evidence.push(await run.evidence('discovery.json', JSON.stringify(report, null, 2)));
  });
  await run.finish();
  assert.equal(report.findings[0].status, 'reproduced');
  const dashboard = await createDashboardServer({ repo: '/synthetic', root, port: 0 });
  const chromiumBrowser = await chromium.launch({ headless: true });
  t.after(async () => { await chromiumBrowser.close(); await dashboard.close(); await rm(root, { recursive: true, force: true }); });
  const context = await chromiumBrowser.newContext({ viewport: { width: 1280, height: 960 } });
  const page = await context.newPage();
  await page.goto(dashboard.origin);
  await page.getByRole('heading', { name: 'Latest exploration recorded.' }).waitFor();
  await page.getByRole('button', { name: 'View evidence' }).click();
  await page.getByRole('heading', { name: /Autonomous discovery · completed/ }).waitFor();
  assert.match(await page.locator('#run-detail').innerText(), /Catalog returns server failure · reproduced/);
  assert.match(await page.locator('#run-detail').innerText(), /Not applicable — exploration/);
  let audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
  assert.deepEqual(audit.violations.map(v => v.id), []);
  await mkdir('.atm/ui', { recursive: true });
  await page.screenshot({ path: '.atm/ui/discovery-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: '.atm/ui/discovery-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Close run details' }).click();
  await page.getByRole('button', { name: 'Explore application', exact: true }).click();
  await page.getByRole('heading', { name: 'Explore application', exact: true }).waitFor();
  assert.match(await page.locator('#launch-description').innerText(), /No test goal/);
  assert.equal(await page.locator('#ai').isVisible(), false);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await writeFile(path.join(run.dir, 'evidence/discovery.json'), '{}');
  await page.getByRole('button', { name: 'View evidence' }).click();
  await page.getByText('Discovery evidence changed.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: /Catalog returns server failure/ }).count(), 0);
});
