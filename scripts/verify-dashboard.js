// Explicit live acceptance test. Requires a running ATM dashboard and Docker.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const origin = process.env.ATM_DASHBOARD_URL ?? 'http://127.0.0.1:4310';
const target = new URL(origin);
if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1') throw new Error('Live QA only targets an ATM dashboard on loopback.');
await mkdir('.atm/ui', { recursive: true, mode: 0o700 });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(origin);
  await page.getByRole('heading', { name: 'Release overview' }).waitFor();
  await page.getByRole('button', { name: 'Run validation' }).click();
  await page.getByLabel('Commit, branch, or tag').fill('HEAD');
  const request = page.waitForResponse(response => response.url() === `${origin}/api/runs` && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Start validation' }).click();
  const response = await request;
  assert.equal(response.status(), 202);
  const { id } = await response.json();
  console.log(`Dashboard launched ${id}`);
  await page.getByRole('button', { name: 'Run this revision again' }).waitFor({ timeout: 900_000 });
  const detail = await (await fetch(`${origin}/api/runs/${id}`)).json();
  await writeFile('.atm/ui/live-acceptance.json', JSON.stringify({ id, decision: detail.run.decision, release: detail.release, integrity: detail.integrity, errors }, null, 2));
  assert.equal(detail.run.decision.status, 'passed', JSON.stringify(detail.run.decision.reasons));
  assert.equal(detail.integrity.status, 'verified');
  assert.equal(detail.run.results.find(r => r.id === 'donor-claim-journey')?.status, 'passed');
  assert.ok(detail.run.policy?.definition, 'Live run must include a versioned policy');
  assert.equal(detail.release.productionAuthorized, false);
  await page.screenshot({ path: '.atm/ui/run-detail.png', fullPage: true });
  await page.getByRole('button', { name: 'Close run details' }).click();
  await page.getByRole('heading', { name: 'Latest candidate passed.' }).waitFor();
  await page.screenshot({ path: '.atm/ui/overview-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: '.atm/ui/overview-mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log(`Live dashboard acceptance passed: ${id}`);
} finally { await browser.close(); }
