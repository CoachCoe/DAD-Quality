import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { command } from '../src/process.js';
import { verifyEvidence } from '../src/core.js';

// Run the actual CLI through browser setup, reports, aggregation and cleanup.
// The isolated child receives a local provider stub and no real credentials.
for (const failure of [false, true])
  test(`benchmark CLI retains all five cases when provider ${failure ? 'fails' : 'returns partial work'}`, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'atm-benchmark-cli-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const preload = path.join(root, 'provider.mjs');
    await writeFile(
      preload,
      `globalThis.fetch = async (url) => {
    if (url !== 'https://tinker.thinkingmachines.dev/services/tinker-prod/anthropic/api/v1/messages') throw new Error('Unexpected external request');
    if (${failure}) return {ok:false,status:502};
    return {ok:true,json:async()=>({stop_reason:'tool_use',content:[{type:'tool_use',name:'investigate_application',input:{action:'finish',target:'',value:'',title:'',reason:'Connection check only.',expectation:'',text:''}}],usage:{input_tokens:2,output_tokens:1}})};
  };`,
    );
    const result = await command(
      process.execPath,
      [
        '--import',
        preload,
        'scripts/benchmark-discovery.js',
        '--live',
        '--max-requests',
        '1',
        '--output',
        path.join(root, 'reports'),
      ],
      // Live 5-case benchmark runs ~56-60s locally; 120s gives headroom under CI load so it is not killed mid-run.
      { timeout: 120_000, env: { ATM_PROVIDER: 'tinker', TINKER_API_KEY: 'test-only', ATM_MODEL: 'test-model' } },
    );
    const summaryPath = result.stdout.match(/Benchmark report: (.+)/)?.[1];
    assert.ok(summaryPath, result.stdout);
    const summary = JSON.parse(await readFile(summaryPath, 'utf8'));
    assert.equal(summary.cases.length, 5);
    assert.equal(summary.metrics.detectedCases, 0);
    assert.equal(summary.metrics.completedCases, 0);
    assert.equal(summary.metrics.requests, 5);
    assert.equal(summary.metrics.tokens, failure ? 0 : 15);
    assert.equal(summary.metrics.usageIncompleteCases, failure ? 5 : 0);
    for (const item of summary.cases) {
      assert.equal(item.status, failure ? 'inconclusive' : 'budget-exhausted');
      const directory = path.join(path.dirname(summaryPath), item.runId);
      const run = JSON.parse(await readFile(path.join(directory, 'run.json'), 'utf8'));
      assert.ok(run.finishedAt);
      assert.equal(run.release.eligible, false);
      assert.match(
        await readFile(path.join(directory, 'report.html'), 'utf8'),
        /No versioned acceptance policy recorded/,
      );
      assert.deepEqual(await verifyEvidence(directory, run), []);
    }
  });
