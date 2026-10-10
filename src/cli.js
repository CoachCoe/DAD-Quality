#!/usr/bin/env node
import { parseArgs } from 'node:util';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { evaluate, redact, verifyEvidence } from './core.js';
import { executeRun } from './runner.js';
import { assessRelease } from './release.js';

const help = `ATM — local application quality runner

  npm run atm -- run --repo /path/to/ImpactGraph [--revision HEAD] [--ai --model MODEL]
  npm run atm -- inspect /path/to/run/run.json
  npm start -- --repo /path/to/ImpactGraph

Options:
  --output DIR      Evidence root (default .atm/runs)
  --policy FILE     Versioned local acceptance policy (default policies/impactgraph-local.json)
  --ai              Add advisory AI exploration; requires OPENAI_API_KEY and --model/ATM_MODEL
  --require-ai      Make AI exploration a required check (implies --ai)
  --help            Show this help

Runs committed source only. Docker and a Playwright Chromium installation are required.
Runtime services use an internal network; payments, mail, and push are disabled.
Exit codes: 0 locally eligible; 1 check failure; 2 inconclusive/invalid evidence; 3 acceptance blocked; 130 canceled.
This local profile does not authorize production release.
`;

export async function main(args = process.argv.slice(2)) {
  process.umask(0o077);
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    repo: { type: 'string' }, revision: { type: 'string', default: 'HEAD' }, output: { type: 'string', default: '.atm/runs' }, policy: { type: 'string' }, ai: { type: 'boolean', default: false }, 'require-ai': { type: 'boolean', default: false }, model: { type: 'string' }, help: { type: 'boolean', default: false },
  } });
  if (values.help || positionals.length === 0) { console.log(help); return 0; }
  if (positionals[0] === 'inspect' && positionals.length === 2) {
    const run = JSON.parse(await readFile(positionals[1], 'utf8'));
    const issues = await verifyEvidence(path.dirname(path.resolve(positionals[1])), run);
    const decision = issues.length ? { status: 'inconclusive', eligible: false, reasons: issues } : run.canceledAt ? { status: 'canceled', eligible: false, reasons: ['Run canceled.'] } : evaluate(run.required, run.results);
    const release = await assessRelease(path.dirname(path.dirname(path.resolve(positionals[1]))), run);
    console.log(JSON.stringify({ id: run.id, candidate: run.candidate, decision, release, recordedRelease: run.release ?? null, evidenceIntegrity: issues.length ? 'invalid' : 'verified' }, null, 2));
    return issues.length ? 2 : exitCode(decision, release);
  }
  if (positionals[0] !== 'run' || positionals.length !== 1 || !values.repo) throw new Error('Use: npm run atm -- run --repo /path/to/ImpactGraph');
  const ai = values.ai || values['require-ai'];
  const model = values.model ?? process.env.ATM_MODEL;
  const controller = new AbortController();
  const cancel = () => { if (!controller.signal.aborted) { console.error('Canceling; cleanup will still run.'); controller.abort(); } };
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  let run;
  try {
    run = await executeRun({ repo: values.repo, revision: values.revision, output: values.output, policy: values.policy, ai, requireAI: values['require-ai'], model, signal: controller.signal });
  } finally {
    process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
  }
  if (controller.signal.aborted) return 130;
  return exitCode(run.data.decision, run.data.release);
}

export function exitCode(decision, release) {
  return decision.status === 'passed' ? release.eligible ? 0 : 3 : ({ failed: 1, inconclusive: 2, canceled: 130 }[decision.status] ?? 2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }).catch(error => { console.error(redact(error.message)); process.exitCode = 2; });
}
