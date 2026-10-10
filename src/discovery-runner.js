import path from 'node:path';
import { Run, RunError, digest, atomicJSON, redact } from './core.js';
import { ImpactGraph } from './impactgraph.js';
import { discover, discoveryProvider, discoveryLimits, discoveryInstructions } from './discovery.js';
import { openDiscoveryBrowser } from './discovery-browser.js';
import { discoveryMemory } from './discovery-report.js';
import { listRuns } from './history.js';
import { hashPolicy, evidenceRequirements } from './policy.js';

export function discoveryPolicy() {
  const times = { snapshot: 60_000, docker: 30_000, build: 1_800_000, database: 180_000, deploy: 180_000, discovery: 660_000, cleanup: 120_000 };
  const definition = { schemaVersion: 1, id: 'impactgraph-discovery', version: '1.0.0', adapter: 'impactgraph', scope: 'exploration', checks: Object.entries(times).map(([id, timeoutMs]) => ({ id, required: true, timeoutMs, evidence: evidenceRequirements[id] })), findings: { blockingSeverities: ['unassessed', 'high', 'critical'] }, exceptions: { mode: 'disabled' } };
  const snapshot = { definition, scenarios: [] };
  return { ...snapshot, digest: hashPolicy(snapshot) };
}

export async function executeDiscovery({ repo, revision = 'HEAD', output = '.atm/runs', model, signal = new AbortController().signal, trigger = 'cli', onCreated = () => {}, provider, adapterFactory = (run, options) => new ImpactGraph(run, options), browserFactory = openDiscoveryBrowser }) {
  // Fail before building images when model configuration is absent.
  const decide = provider ?? discoveryProvider({ apiKey: process.env.OPENAI_API_KEY, model });
  const policy = discoveryPolicy();
  const run = await Run.create(output, { adapter: 'impactgraph', revision, mode: 'exploration', model, trigger }, policy.definition.checks.map(c => c.id), policy);
  onCreated(run);
  console.log(`Exploration evidence: ${run.dir}`);
  const adapter = adapterFactory(run, { repo, revision, signal });
  const step = async (id, action) => {
    const check = policy.definition.checks.find(c => c.id === id);
    const deadline = AbortSignal.timeout(check.timeoutMs);
    adapter.signal = id === 'cleanup' ? deadline : AbortSignal.any([signal, deadline]);
    return run.step(id, async result => {
      result.timeoutMs = check.timeoutMs;
      const outcome = await action(result);
      if (deadline.aborted) throw new RunError(`${id} exceeded its time budget.`);
      return outcome;
    });
  };
  try {
    let ready = true;
    for (const id of ['snapshot', 'docker', 'build', 'database', 'deploy']) {
      if (!ready || signal.aborted) break;
      ready = await step(id, result => adapter[id](result));
    }
    if (ready && !signal.aborted) await step('discovery', async result => {
      const { runs, warnings } = await listRuns(output);
      const carried = await discoveryMemory(output, runs, run.data.candidate);
      const report = { version: 1, runId: run.data.id, revision: run.data.candidate.revision, source: run.data.candidate.source, model: model ?? 'injected-provider', promptSha256: digest(discoveryInstructions), limits: discoveryLimits, startedAt: new Date().toISOString(), status: 'running', summary: '', requests: 0, tokens: 0, pages: [], investigations: [], observations: [], events: [], findings: [], memory: carried.memory, warnings: [...warnings, ...carried.warnings] };
      const update = async () => {
        // Redact string values before serializing, so hostile page text such as
        // "Cookie: ..." cannot make a JSON report syntactically invalid.
        const safe = JSON.parse(JSON.stringify(report, (_key, value) => typeof value === 'string' ? redact(value) : value));
        await atomicJSON(path.join(run.dir, 'evidence/discovery.json'), safe);
        const reference = await run.reference('evidence/discovery.json');
        result.evidence = result.evidence.filter(e => e.path !== reference.path);
        result.evidence.push(reference);
        await run.save();
      };
      let browser;
      try {
        await update();
        const actors = await adapter.discoveryFixture();
        report.actors = actors.map(({ id, description, entry }) => ({ id, description, entry }));
        const explorationSignal = AbortSignal.any([adapter.signal, AbortSignal.timeout(discoveryLimits.durationMs)]);
        browser = await browserFactory({ origin: adapter.publicOrigin, actors, signal: explorationSignal, run, result });
        await discover({ provider: decide, browser, report, memory: carried.memory, signal: explorationSignal, onUpdate: update });
      } catch (error) {
        report.status = signal.aborted ? 'canceled' : 'inconclusive';
        report.summary = error.message;
      } finally {
        try { if (browser) { report.blockedRequests = browser.blocked; await browser.close(); } }
        finally { report.finishedAt ??= new Date().toISOString(); await update(); }
      }
      return { status: report.status === 'completed' ? 'passed' : signal.aborted ? 'canceled' : 'inconclusive', summary: `${report.investigations.length} self-selected investigations; ${report.findings.length} potential findings (${report.findings.filter(f => f.status === 'reproduced').length} reproduced). ${report.summary}` };
    });
  } finally {
    await step('cleanup', result => adapter.cleanup(result));
    for (const check of policy.definition.checks) if (!run.data.results.some(r => r.id === check.id)) run.data.results.push({ id: check.id, required: true, status: signal.aborted ? 'canceled' : 'inconclusive', summary: 'Not executed; prerequisite unavailable.', evidence: [] });
    if (signal.aborted) run.data.canceledAt = new Date().toISOString();
    run.data.release = { status: 'not-applicable', eligible: false, scope: 'exploration', productionAuthorized: false, reasons: ['Discovery reports observations and hypotheses; it does not assess release readiness.'] };
    await run.finish();
  }
  console.log(`Exploration ${run.data.decision.status}: ${path.join(run.dir, 'report.html')}`);
  return run;
}
