import test from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkApplication } from '../src/discovery-benchmark.js';
import { openDiscoveryBrowser } from '../src/discovery-browser.js';
import { discover } from '../src/discovery.js';

const action = (kind, fields = {}) => ({ action: kind, target: '', value: '', title: '', reason: 'Names persist after saving and remain isolated between actors.', expectation: '', text: '', ...fields });
const signal = new AbortController().signal;
const control = (observation, label) => observation.controls.find(c => c.label === label).id;

test('code-informed persistence investigation reproduces lost writes on a clean fixture and exports honest coverage', async t => {
  const app = await benchmarkApplication('lost-save');
  const browser = await openDiscoveryBrowser({ ...app, signal });
  t.after(async () => { await browser.close(); await app.close(); });
  let step = 0;
  const report = { requests: 0, tokens: 0, pages: [], observations: [], investigations: [], events: [], findings: [] };
  const provider = async ({ observation, sourceEvidence }) => {
    const decisions = [
      () => action('read_source', { target: 'docs/profile.md' }),
      () => { assert.equal(sourceEvidence[0].result.path, 'docs/profile.md'); return action('investigate', { title: 'Profile persistence', value: JSON.stringify({ capability: 'Profile', behavior: 'Save persists', state: 'Valid name', preconditions: 'Donor A signed in', expected: 'New name persists after reload', basis: 'documented', references: ['docs/profile.md'], checks: [{ id: 'fill', kind: 'action', action: 'fill', actor: 'donor-a', target: 'Public name', value: 'Changed' }, { id: 'save', kind: 'action', action: 'click', actor: 'donor-a', target: 'Save profile', value: '' }, { id: 'reload', kind: 'action', action: 'reload', actor: 'donor-a', target: '', value: '' }, { id: 'field', kind: 'assertion', expectation: 'field_value', actor: 'donor-a', target: 'Public name', value: '', text: 'Changed', baseline: '' }, { id: 'stored', kind: 'assertion', expectation: 'state_equals', actor: 'donor-a', target: 'donor-a', value: 'public_name', text: 'Changed', baseline: '' }] }) }); },
      () => action('switch_actor', { target: 'donor-a' }),
      () => action('fill', { target: control(observation, 'Public name'), value: 'Changed' }),
      () => action('click', { target: control(observation, 'Save profile') }),
      () => action('reload'),
      () => action('verify', { target: 'field' }),
      () => action('verify', { target: 'stored' }),
      () => action('report_check', { title: 'Profile changes are not persisted', target: 'stored' }),
      () => action('conclude', { value: 'refuted' }),
      () => action('finish'),
    ];
    return { action: decisions[step++](), tokens: 5 };
  };
  await discover({ provider, source: { act: async () => ({ path: 'docs/profile.md', text: 'Save persists the name', sha256: 'test' }) }, browser, report, signal });
  assert.equal(report.status, 'completed'); assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].status, 'reproduced'); assert.equal(report.findings[0].reproduction.cleanFixture, true);
  assert.equal(app.judge(report.findings[0]), true); assert.equal(report.coverage.experiments[0].status, 'refuted');
  const after = await browser.observe(); assert.equal(after.state['donor-a'].public_name, 'Alex');
});

test('cross-user mutation replay includes the earlier actor actions and restores working state without duplicate writes', async t => {
  const app = await benchmarkApplication('cross-actor');
  const browser = await openDiscoveryBrowser({ ...app, signal });
  t.after(async () => { await browser.close(); await app.close(); });
  await browser.act(action('switch_actor', { target: 'donor-a' }));
  let observation = await browser.observe();
  await browser.act(action('fill', { target: control(observation, 'Public name'), value: 'Changed' }));
  observation = await browser.observe();
  await browser.act(action('click', { target: control(observation, 'Save profile') }));
  await browser.act(action('switch_actor', { target: 'donor-b' }));
  observation = await browser.observe();
  assert.equal(observation.state['donor-a'].save_count, 1);
  const replay = await browser.reproduce(action('report', { title: 'Donor B changed', expectation: 'state_equals', target: 'donor-b', value: 'public_name', text: 'Blair' }), observation);
  assert.equal(replay.status, 'reproduced'); assert.equal(replay.steps.filter(s => s.action === 'switch_actor').length, 2);
  const after = await browser.observe(); assert.equal(after.actor, 'donor-b');
  assert.equal(after.state['donor-a'].save_count, 1, 'Replay must not append writes to working data');
});

test('typed field replay verifies the same observed field and healthy saves satisfy both browser and persisted checks', async t => {
  const app = await benchmarkApplication();
  const browser = await openDiscoveryBrowser({ ...app, signal });
  t.after(async () => { await browser.close(); await app.close(); });
  await browser.act(action('switch_actor', { target: 'donor-a' }));
  let observation = await browser.observe();
  await browser.act(action('fill', { target: control(observation, 'Public name'), value: 'Changed' }));
  observation = await browser.observe(); await browser.act(action('click', { target: control(observation, 'Save profile') }));
  await browser.act(action('reload')); observation = await browser.observe();
  assert.equal(observation.state['donor-a'].public_name, 'Changed');
  const result = await browser.reproduce(action('report', { title: 'Invented mismatch', expectation: 'field_value', target: control(observation, 'Public name'), text: 'Changed' }), observation);
  assert.equal(result.status, 'not-reproduced');
  assert.equal(result.observation.controls[0].value, 'Changed');
});

test('a failed fixture restoration cannot be followed by a successful exploration', async t => {
  const app = await benchmarkApplication('lost-save');
  const fixture = { ...app.fixture, replay: async () => { const restore = await app.fixture.replay(); return async () => { await restore(); throw new Error('Storage unavailable'); }; } };
  const browser = await openDiscoveryBrowser({ ...app, fixture, signal });
  t.after(async () => { await browser.close(); await app.close(); });
  await browser.observe();
  await assert.rejects(browser.reproduce(action('report', { expectation: 'text_present', text: 'Missing' })), /restoration failed/);
  await assert.rejects(browser.observe(), /cannot continue/);
});

for (const [fault, name, field, expected] of [['accept-invalid', '   ', 'public_name', 'Alex'], ['duplicate-write', 'Changed', 'save_count', '1']]) {
  test(`benchmark oracle independently scores ${fault} without exposing fault labels to the investigator`, async t => {
    const app = await benchmarkApplication(fault);
    const browser = await openDiscoveryBrowser({ ...app, signal });
    t.after(async () => { await browser.close(); await app.close(); });
    await browser.act(action('switch_actor', { target: 'donor-a' }));
    let observation = await browser.observe();
    await browser.act(action('fill', { target: control(observation, 'Public name'), value: name }));
    observation = await browser.observe();
    await browser.act(action('click', { target: control(observation, 'Save profile') }));
    observation = await browser.observe();
    const assertion = action('report', { title: 'Contract violation', expectation: 'state_equals', target: 'donor-a', value: field, text: expected });
    const reproduction = await browser.reproduce(assertion, observation);
    assert.equal(reproduction.status, 'reproduced');
    const finding = { assertion, expectation: 'state_equals', text: expected, status: 'reproduced', initial: { observationId: observation.id }, reproduction };
    assert.equal(app.judge(finding), true);
    assert.equal(app.judge({ ...finding, text: 'invented requirement' }), false);
  });
}
