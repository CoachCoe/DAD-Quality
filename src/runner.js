import path from 'node:path';
import { modelConfig } from './model-provider.js';
import { Run, RunError } from './core.js';
import { ImpactGraph } from './impactgraph.js';
import { staffJourney, donorClaimJourney } from './browser.js';
import { publicAgent } from './agent.js';
import { loadPolicy } from './policy.js';
import { assessRelease } from './release.js';
import { performanceCheck } from './performance.js';

export async function executeRun({ repo, revision = 'HEAD', sourceIdentity, output = '.atm/runs', policy: policyFile, ai = false, requireAI = false, model, providerName, signal = new AbortController().signal, trigger = 'cli', onCreated = () => {} }) {
  const policy = await loadPolicy(policyFile, { ai, requireAI });
  if (policy.definition.scope !== 'local-acceptance') throw new Error('Use the explore command for autonomous discovery.');
  const checks = policy.definition.checks;
  const required = checks.filter(c => c.required).map(c => c.id);
  const config = checks.some(c => c.id === 'ai-public-journey') ? modelConfig({ model, providerName }) : {};
  model = config.model ?? model;
  const run = await Run.create(output, { adapter: 'impactgraph', revision, ai: checks.some(c => c.id === 'ai-public-journey'), model, provider: config.providerName, trigger }, required, policy);
  onCreated(run);
  console.log(`Evidence: ${run.dir}`);
  const adapter = new ImpactGraph(run, { repo, revision, sourceIdentity, signal });
  const step = async (id, action) => {
    const check = checks.find(c => c.id === id);
    if (!check) return true;
    const deadline = AbortSignal.timeout(check.timeoutMs);
    adapter.signal = id === 'cleanup' ? deadline : AbortSignal.any([signal, deadline]);
    return run.step(id, async result => {
      result.timeoutMs = check.timeoutMs;
      if (check.scenario) result.scenario = check.scenario;
      try {
        const outcome = await action(result);
        if (deadline.aborted) throw new RunError(`${id} exceeded its policy time budget.`);
        return outcome;
      } catch (error) {
        if (deadline.aborted && !signal.aborted) throw new RunError(`${id} exceeded its policy time budget.`);
        throw error;
      }
    });
  };
  try {
    let ready = true;
    for (const stage of ['snapshot', 'docker', 'build', 'database']) {
      if (!ready) break;
      ready = await step(stage, result => adapter[stage](result));
    }
    if (ready && !signal.aborted) {
      await step('api-tests', result => adapter.suite(result, 'api-tests'));
      await step('web-tests', result => adapter.suite(result, 'web-tests'));
      if (!signal.aborted && await step('deploy', result => adapter.deploy(result))) {
        for (const [id, handler] of [['staff-journey', staffJourney], ['donor-claim-journey', donorClaimJourney]]) {
          if (!signal.aborted) await step(id, result => handler(adapter, result));
        }
        if (!signal.aborted) await step('ai-public-journey', result => publicAgent(adapter, result, { model, providerName }));
        if (!signal.aborted) await step('performance', result => performanceCheck(adapter, result, checks.find(c => c.id === 'performance').profile));
      }
    }
  } finally {
    await step('cleanup', result => adapter.cleanup(result));
    for (const check of checks) {
      if (!run.data.results.some(result => result.id === check.id)) run.data.results.push({ id: check.id, required: check.required, status: signal.aborted ? 'canceled' : 'inconclusive', summary: 'Not executed because a prerequisite did not complete.', evidence: [] });
    }
    if (signal.aborted) run.data.canceledAt = new Date().toISOString();
    await run.finish();
    run.data.release = await assessRelease(path.resolve(output), run.data);
    await run.save();
  }
  console.log(`\nChecks: ${run.data.decision.status.toUpperCase()} · Local acceptance: ${run.data.release.status.toUpperCase()} · ${path.join(run.dir, 'report.html')}`);
  return run;
}
