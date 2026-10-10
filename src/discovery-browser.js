import path from 'node:path';
import { openBrowser } from './browser.js';
import { discoveryLimits, evaluateExpectation } from './discovery.js';
import { redact } from './core.js';

const clean = value => redact(String(value)).slice(0, 12_000);
// Evaluated in the page for both observation and execution. Inputs often have
// no textContent, so labels, names and destinations are part of their identity.
const controlIdentity = el => JSON.stringify([el.tagName, el.getAttribute('type'), el.getAttribute('role'), el.getAttribute('aria-label'), el.getAttribute('name'), el.getAttribute('id'), el.getAttribute('placeholder'), el.getAttribute('href'), [...(el.labels ?? [])].map(label => label.textContent?.trim()), el.textContent?.trim().slice(0, 120)]);
export async function openDiscoveryBrowser({ origin, actors, signal, run, result }) {
  const permitted = new URL(origin);
  if (permitted.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(permitted.hostname) || !permitted.port || permitted.pathname !== '/' || permitted.username || permitted.password) throw new Error('Discovery requires a run-owned loopback origin.');
  let session, page, segment = 0;
  const blocked = [];
  const known = new Map();
  let controls = new Map(), actor = actors[0], trail = [], dirty = false, sequence = 0, lastObservation;
  let serverErrors = [], pageErrors = [];
  const relative = raw => { const u = new URL(raw, origin); return clean(`${u.pathname}${u.search}${u.hash}`); };
  const capture = (target, errors) => {
    target.on('response', response => { if (response.status() >= 500 && errors.server.length < 20) errors.server.push({ path: relative(response.url()), status: response.status() }); });
    target.on('pageerror', error => { if (errors.page.length < 20) errors.page.push(clean(error.message).slice(0, 600)); });
  };
  const errors = { server: serverErrors, page: pageErrors };
  const resetErrors = () => { errors.server = serverErrors = []; errors.page = pageErrors = []; };
  const closeSession = async () => {
    const previous = session;
    session = null;
    if (!previous) return;
    blocked.push(...previous.blocked);
    try {
      if (run) {
        const name = segment === 1 ? 'discovery-trace.zip' : `discovery-trace-${segment}.zip`;
        await previous.context.tracing.stop({ path: path.join(run.dir, 'evidence', name) });
        result.evidence.push(await run.reference(`evidence/${name}`));
      }
    } finally { await previous.close(); }
  };
  const recordURL = (raw, title = '') => {
    let url;
    try { url = new URL(raw, origin); } catch { return; }
    if (url.origin !== origin || url.username || url.password || !['http:', 'https:'].includes(url.protocol)) return;
    if (known.has(url.href)) return known.get(url.href);
    if (known.size >= 120) return;
    const record = { id: `p${known.size + 1}`, url: url.href, path: relative(url.href), title: clean(title).slice(0, 160), visitedBy: [] };
    known.set(url.href, record);
    return record;
  };
  const bootstrap = async (context, who) => {
    await context.clearCookies();
    if (who.cookie) await context.addCookies([{ name: 'dad_donor_session', value: who.cookie, url: origin, httpOnly: true, sameSite: 'Lax' }]);
  };
  const settle = async target => {
    await target.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    // Give client rendering and fetches a bounded opportunity to settle. Never
    // interpret network idleness as a correctness or completion assertion.
    await target.waitForTimeout(300);
  };
  const start = async who => {
    await closeSession();
    actor = who; trail = []; controls.clear(); resetErrors();
    // A new context also isolates IndexedDB, Cache Storage and browser caches.
    // Clearing cookies/localStorage alone can manufacture cross-user findings.
    session = await openBrowser([origin], { signal });
    segment++;
    try {
      session.context.setDefaultTimeout(5000);
      await session.context.tracing.start({ screenshots: true, snapshots: true, sources: false });
      page = await session.newPage();
      capture(page, errors);
      page.on('request', request => { if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) dirty = true; });
      await bootstrap(session.context, actor);
      await page.goto(new URL(actor.entry ?? '/', origin).href, { timeout: 10000 });
      await settle(page);
    } catch (error) {
      try { await closeSession(); } catch { /* Preserve the startup error. */ }
      throw error;
    }
  };
  await start(actor);

  async function evidence(target, who, currentErrors, save = false) {
    const rawText = await target.locator('body').innerText({ timeout: 5000 });
    const id = `o${++sequence}`;
    const observation = { id, actor: who.id, path: relative(target.url()), text: clean(rawText).slice(0, 8000), textTruncated: rawText.length > 8000, serverErrors: structuredClone(currentErrors.server), pageErrors: structuredClone(currentErrors.page) };
    if (save && run) {
      const name = `discovery-${id}.png`;
      await target.screenshot({ path: path.join(run.dir, 'evidence', name), fullPage: false, timeout: 5000 });
      result.evidence.push(await run.reference(`evidence/${name}`));
      observation.screenshot = `evidence/${name}`;
    }
    return observation;
  }
  const perform = async (target, spec) => {
    if (spec.action === 'navigate') { await target.goto(spec.url, { timeout: 10000 }); return; }
    if (spec.action === 'reload') { await target.reload({ timeout: 10000 }); return; }
    const locator = target.locator(spec.selector);
    if (await locator.count() !== 1 || !await locator.isVisible()) throw new Error('Observed control is no longer uniquely visible. Observe again.');
    const identity = await locator.evaluate(controlIdentity);
    if (identity !== spec.identity) throw new Error('Observed control changed; replay/action stopped.');
    if (spec.action === 'click') await locator.click({ timeout: 5000 });
    else if (spec.action === 'fill') await locator.fill(spec.value, { timeout: 5000 });
    else if (spec.action === 'select') await locator.selectOption({ label: spec.value }, { timeout: 5000 });
    else if (spec.action === 'check') {
      if (!['true', 'false'].includes(spec.value)) throw new Error('check value must be true or false.');
      await locator.setChecked(spec.value === 'true', { timeout: 5000 });
    } else throw new Error('Unsupported browser action.');
  };
  return {
    pages: () => structuredClone([...known.values()].map(({ url: _url, ...item }) => item)),
    async observe() {
      signal.throwIfAborted();
      const current = recordURL(page.url(), await page.title());
      if (current && !current.visitedBy.includes(actor.id)) current.visitedBy.push(actor.id);
      const observation = await evidence(page, actor, errors, true);
      controls = new Map();
      const elements = await page.locator('a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link]').elementHandles();
      const visible = [];
      for (const handle of elements.slice(0, 200)) {
        if (visible.length >= 60) break;
        if (!await handle.isVisible()) continue;
        const info = await handle.evaluate(el => {
          const parts = []; let current = el;
          while (current && current.nodeType === 1) {
            const siblings = [...(current.parentElement?.children ?? [current])].filter(s => s.tagName === current.tagName);
            parts.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(current) + 1})`);
            current = current.parentElement;
          }
          return { selector: parts.join(' > '), tag: el.tagName.toLowerCase(), type: el.getAttribute('type') ?? '', label: (el.getAttribute('aria-label') || el.labels?.[0]?.innerText || el.innerText || el.getAttribute('placeholder') || el.getAttribute('name') || '').slice(0, 180), value: el.type === 'password' ? '[hidden]' : String(el.value ?? '').slice(0, 300), href: el.tagName === 'A' ? el.href : null, newWindow: el.tagName === 'A' && el.target && el.target !== '_self', options: el.tagName === 'SELECT' ? [...el.options].slice(0, 20).map(o => o.label) : undefined };
        });
        if (info.newWindow || info.type === 'password' || info.type === 'file') continue;
        info.identity = await handle.evaluate(controlIdentity);
        const id = `c${visible.length + 1}`;
        controls.set(id, info);
        const link = info.href ? recordURL(info.href, info.label) : null;
        visible.push({ id, tag: info.tag, type: info.type, label: clean(info.label), value: clean(info.value), options: info.options, page: link?.id ?? null });
      }
      observation.controls = visible;
      observation.actors = actors.map(({ id, description }) => ({ id, description }));
      observation.pages = this.pages();
      lastObservation = structuredClone(observation);
      return observation;
    },
    async act(action) {
      signal.throwIfAborted();
      if (action.action === 'switch_actor') {
        const who = actors.find(a => a.id === action.target);
        if (!who) throw new Error('Unknown actor.');
        await start(who); return;
      }
      let spec = { action: action.action, value: action.value };
      if (action.action === 'navigate') {
        const route = [...known.values()].find(p => p.id === action.target);
        if (!route) throw new Error('Navigate only to a discovered page ID.');
        spec.url = route.url;
      } else if (action.action !== 'reload') {
        const control = controls.get(action.target);
        if (!control) throw new Error('Use a control ID from the current observation.');
        if (control.href && ![...known.values()].some(p => p.url === control.href)) throw new Error('Link is outside the permitted application.');
        spec = { ...spec, selector: control.selector, identity: control.identity };
      }
      resetErrors();
      // Include failed/partially executed actions in reproduction; never pretend
      // the subsequent state was reached through a shorter successful sequence.
      trail.push(spec);
      await perform(page, spec);
      await settle(page);
    },
    async reproduce(action, original = lastObservation) {
      const steps = structuredClone(trail);
      const expectedPath = original?.path;
      const originalErrors = { server: original?.serverErrors ?? [], page: original?.pageErrors ?? [] };
      const base = { actor: actor.id, entry: actor.entry ?? '/', steps, status: 'inconclusive' };
      if (!original || original.actor !== actor.id) return { ...base, reason: 'No matching original observation; mismatch is not verified.' };
      if (dirty) return { ...base, reason: 'Application received a mutation. Automatic replay requires a pristine fixture and is deferred; no mutation was repeated.' };
      if (steps.length > discoveryLimits.replayActions) return { ...base, reason: 'Replay action budget exceeded.' };
      const replay = await openBrowser([origin], { readOnly: true, signal });
      const replayErrors = { server: [], page: [] };
      try {
        const target = await replay.newPage();
        capture(target, replayErrors);
        await bootstrap(replay.context, actor);
        await target.goto(new URL(actor.entry ?? '/', origin).href, { timeout: 10000 });
        await settle(target);
        for (const spec of steps) {
          replayErrors.server = []; replayErrors.page = [];
          await perform(target, spec); await settle(target);
        }
        const observation = await evidence(target, actor, replayErrors, true);
        const verification = evaluateExpectation(action, observation);
        if (replay.blocked.length) return { ...base, observation, verification, reason: 'Replay attempted a forbidden request; mismatch is not verified.' };
        if (observation.path !== expectedPath) return { ...base, observation, verification, reason: 'Replay reached a different page; mismatch is not verified.' };
        if (action.expectation === 'no_server_error' && !observation.serverErrors.some(e => originalErrors.server.some(o => o.path === e.path && o.status === e.status))) return { ...base, observation, verification, reason: 'The same server failure did not recur.' };
        if (action.expectation === 'no_page_error' && !observation.pageErrors.some(e => originalErrors.page.includes(e))) return { ...base, observation, verification, reason: 'The same JavaScript failure did not recur.' };
        return { ...base, observation, verification, status: !verification.evaluable ? 'inconclusive' : verification.passed ? 'not-reproduced' : 'reproduced' };
      } catch (error) { return { ...base, reason: clean(error.message).slice(0, 600) }; }
      finally { await replay.close(); }
    },
    close: closeSession,
    get blocked() { return [...blocked, ...(session?.blocked ?? [])]; },
  };
}
