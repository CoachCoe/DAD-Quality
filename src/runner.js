import path from 'node:path';
import { Run } from './core.js';
import { ImpactGraph, requiredChecks } from './impactgraph.js';
import { staffJourney } from './browser.js';
import { publicAgent } from './agent.js';

export async function executeRun({ repo, revision = 'HEAD', output = '.atm/runs', ai = false, requireAI = false, model, signal = new AbortController().signal, trigger = 'cli', onCreated = () => {} }) {
  const required = [...requiredChecks, ...(requireAI ? ['ai-public-journey'] : [])];
  const run = await Run.create(output, { adapter: 'impactgraph', revision, ai: ai || requireAI, model, trigger }, required);
  onCreated(run);
  console.log(`Evidence: ${run.dir}`);
  const adapter = new ImpactGraph(run, { repo, revision, signal });
  try {
    let ready = true;
    for (const stage of ['snapshot', 'docker', 'build', 'database']) {
      if (!ready) break;
      ready = await run.step(stage, result => adapter[stage](result));
    }
    if (ready && !signal.aborted) {
      await run.step('api-tests', result => adapter.suite(result, 'api-tests'));
      await run.step('web-tests', result => adapter.suite(result, 'web-tests'));
      if (!signal.aborted && await run.step('deploy', result => adapter.deploy(result))) {
        await run.step('staff-journey', result => staffJourney(adapter, result));
        if ((ai || requireAI) && !signal.aborted) await run.step('ai-public-journey', result => publicAgent(adapter, result, { model, apiKey: process.env.OPENAI_API_KEY }));
      }
    }
  } finally {
    await run.step('cleanup', result => adapter.cleanup(result));
    for (const id of required) {
      if (!run.data.results.some(result => result.id === id)) run.data.results.push({ id, required: true, status: signal.aborted ? 'canceled' : 'inconclusive', summary: 'Not executed because a prerequisite did not complete.', evidence: [] });
    }
    if (signal.aborted) run.data.canceledAt = new Date().toISOString();
    await run.finish();
  }
  console.log(`\n${run.data.decision.status.toUpperCase()} · ${path.join(run.dir, 'report.html')}`);
  return run;
}
