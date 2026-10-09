import test from 'node:test';
import assert from 'node:assert/strict';
import { command, cleanEnvironment } from '../src/process.js';

test('child processes do not inherit provider or application credentials', () => {
  process.env.ATM_TEST_SECRET = 'should-not-leak';
  try { assert.equal(cleanEnvironment().ATM_TEST_SECRET, undefined); }
  finally { delete process.env.ATM_TEST_SECRET; }
  assert.equal(cleanEnvironment({ SYNTHETIC: 'yes' }).SYNTHETIC, 'yes');
});

test('command uses argument arrays without shell interpolation', async () => {
  const literal = '$(echo unsafe); `echo unsafe`';
  const result = await command(process.execPath, ['-e', 'console.log(process.argv[1])', literal]);
  assert.equal(result.stdout.trim(), literal);
});

test('nonzero exit retains diagnostic output and supplied classification', async () => {
  await assert.rejects(command(process.execPath, ['-e', 'console.error("assertion failed");process.exit(1)'], { failureStatus: 'failed' }), e => e.status === 'failed' && e.stderr.includes('assertion failed'));
});

test('hung commands and excess output are inconclusive', async () => {
  await assert.rejects(command(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 100 }), e => e.status === 'inconclusive' && e.message.includes('timeout'));
  await assert.rejects(command(process.execPath, ['-e', 'process.stdout.write("x".repeat(2000))'], { maxBytes: 100 }), e => e.status === 'inconclusive' && e.message.includes('output limit'));
});

test('cancellation terminates an active process', async () => {
  const controller = new AbortController();
  const promise = command(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(promise, e => e.status === 'canceled');
});
