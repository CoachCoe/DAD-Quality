import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { digest } from '../core.js';
import { benchmarkApplication, benchmarkContract, benchmarkSource } from '../discovery-benchmark.js';

// Serves the healthy benchmark application in-process. The container phases only
// record that they do not apply, so their policy-required evidence still exists.
export class BenchmarkAdapter {
  /**
   * @param {any} run
   * @param {{signal?: AbortSignal}} [options]
   */
  constructor(run, { signal } = {}) {
    this.run = run;
    this.signal = signal;
    this.source = path.join(run.dir, 'source');
  }
  async snapshot(result) {
    this.app = await benchmarkApplication('healthy');
    this.publicOrigin = this.app.origin;
    this.run.data.candidate = {
      revision: digest(benchmarkSource + benchmarkContract).slice(0, 40),
      source: 'benchmark:synthetic-profile',
    };
    await mkdir(this.source, { mode: 0o700 });
    await writeFile(path.join(this.source, 'README.md'), benchmarkContract, { mode: 0o600 });
    await writeFile(path.join(this.source, 'profile.js'), benchmarkSource, { mode: 0o600 });
    result.evidence.push(await this.run.evidence('candidate.json', JSON.stringify(this.run.data.candidate, null, 2)));
    return { summary: `In-process benchmark application provisioned at ${this.publicOrigin}.` };
  }
  async notApplicable(result, logs, summary) {
    for (const name of logs)
      result.evidence.push(await this.run.evidence(name, 'Not applicable: in-process benchmark.'));
    return { summary };
  }
  docker(result) {
    return this.notApplicable(result, ['docker.log', 'compose-version.log'], 'Docker not used by the benchmark.');
  }
  build(result) {
    return this.notApplicable(result, ['build-api.log', 'build-web.log'], 'No images built for the benchmark.');
  }
  database(result) {
    return this.notApplicable(
      result,
      ['migrations.log', 'test-migrations.log'],
      'Benchmark state is in-memory; no database migrations.',
    );
  }
  deploy(result) {
    return this.notApplicable(result, ['readiness.log'], 'Benchmark server already serving in-process.');
  }
  discoveryFixture() {
    return this.app.actors.map(actor => (actor.cookie ? { ...actor, cookieName: 'session' } : actor));
  }
  discoveryReplayFixture() {
    return this.app.fixture;
  }
  async cleanup(result) {
    await this.app?.close();
    result.evidence.push(await this.run.evidence('cleanup.log', 'In-process benchmark server stopped.'));
    return { summary: 'In-process benchmark server stopped.' };
  }
}
