import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { command } from '../process.js';
import { digest, RunError } from '../core.js';

/**
 * Formal discovery target-adapter interface.
 *
 * This is the contract the discovery runner (`src/discovery-runner.js`,
 * `executeDiscovery`) relies on today, extracted verbatim from the runner's
 * actual call sites. Adapters are plain ESM classes that structurally satisfy
 * it (duck-typed, no `implements`). `ProvisioningAdapter` below is a convenience
 * base that owns the shared Docker/compose/git provisioning machinery for
 * container-backed targets; an adapter does NOT have to extend it (the
 * in-process benchmark adapter does not). The interface is the real contract;
 * the base class is a convenience for provisioning targets.
 *
 * Lifecycle and ordering guarantees the runner provides:
 *  1. Construction: `adapterFactory(run, { repo, revision, signal })` once.
 *  2. Provisioning phases, in this exact order: `snapshot` -> `docker` ->
 *     `build` -> `database` -> `deploy`. A falsy "ready" value or an aborted
 *     outer signal stops the chain.
 *  3. Discovery phase: runs after `deploy`, reads the getters/fixtures below
 *     and drives a browser against `publicOrigin`.
 *  4. Cleanup always runs in a `finally`, even on failure/abort; it must
 *     tolerate being called when little or nothing was provisioned.
 *
 * Signal discipline is owned by the runner: it assigns `adapter.signal` fresh
 * before each phase (and a teardown-only budget for cleanup). The adapter reads
 * `this.signal` at the start of each method; it does not create it.
 *
 * Evidence ownership (fold-in #5): the discovery-phase evidence
 * (`discovery.json`, `discovery-trace.zip`) and the acceptance-only journey
 * evidence are produced by the RUNNER/engine, NOT by the adapter. The adapter
 * owns only the five provisioning phases' evidence — `candidate.json`;
 * `docker.log`, `compose-version.log`; `build-api.log`, `build-web.log`;
 * `migrations.log`, `test-migrations.log`; `readiness.log` — plus `cleanup.log`.
 */

/**
 * An actor descriptor returned by `discoveryFixture()`.
 *
 * @typedef {object} Actor
 * @property {string} id            Stable actor id (e.g. 'guest', 'donor-a'). Required.
 * @property {string} description   Human/agent-facing summary. Required.
 * @property {string} entry         Loopback-relative entry path (e.g. '/', '/account/dashboard'). Required.
 * @property {string} [cookie]      Session cookie VALUE; omit for anonymous actors.
 * @property {string} [cookieName]  Cookie NAME; only meaningful alongside `cookie`. Treated as an opaque optional string.
 */

/**
 * A replay fixture returned by the optional `discoveryReplayFixture()`.
 *
 * @typedef {object} Fixture
 * @property {() => Promise<unknown>} [replay]   Replays recorded mutations, resolving to a restore handle.
 * @property {() => Promise<unknown>} [inspect]  Projects current fixture state (read-only).
 */

/**
 * The target-adapter contract consumed by the discovery runner.
 *
 * Required provisioning methods — each takes the per-phase `result` (appends
 * evidence via `result.evidence.push(await run.evidence(name, text))`), returns
 * `{ summary: string }`, or a falsy value / throws to signal "not ready":
 *  - `snapshot(result)`   materialize the candidate; sets `run.data.candidate`; writes `candidate.json`.
 *  - `docker(result)`     provisioning readiness (DAD: port, origin, credentials, compose file).
 *  - `build(result)`      build/prepare runnable artifacts.
 *  - `database(result)`   bring up data stores + run migrations.
 *  - `deploy(result)`     start the app and assert health against `publicOrigin`.
 *  - `cleanup(result)`    tear down everything provisioning created. ALWAYS called; must be idempotent.
 *
 * Required fields/getters read by the discovery phase:
 *  - `publicOrigin: string`   loopback origin the browser drives (http:, localhost/127.0.0.1, explicit port, path '/').
 *  - `signal: AbortSignal`    writable; assigned by the runner per phase.
 *  - `discoveryFixture(): Promise<Actor[]> | Actor[]`   provisions synthetic identities; returns actor descriptors.
 *
 * Optional (the runner degrades gracefully when absent):
 *  - `discoveryReplayFixture(): Promise<Fixture> | Fixture | undefined`   called only if the property exists.
 *  - `source: string | undefined`   absolute path to a source root for `sourceReader`.
 *
 * @typedef {object} DiscoveryTargetAdapter
 * @property {string} publicOrigin
 * @property {AbortSignal} signal
 * @property {(result: object) => unknown} snapshot
 * @property {(result: object) => unknown} docker
 * @property {(result: object) => unknown} build
 * @property {(result: object) => unknown} database
 * @property {(result: object) => unknown} deploy
 * @property {(result: object) => unknown} cleanup
 * @property {() => Promise<Actor[]> | Actor[]} discoveryFixture
 * @property {() => Promise<Fixture> | Fixture | undefined} [discoveryReplayFixture]
 * @property {string} [source]
 */

/**
 * Shared base for container-backed provisioning adapters. Owns cross-cutting
 * run bookkeeping plus the subprocess/compose/git/sql helpers. Target-specific
 * values (service names, env var names, db/roles, required files, SQL builders,
 * and the exploration-vs-acceptance mode branching) live in the subclass/config,
 * NOT here.
 */
export class ProvisioningAdapter {
  constructor(run) {
    this.run = run;
    this.id = run.data.id;
    this.signal = undefined;
    this.created = false;
  }

  async freePort() {
    const server = createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
  }

  async logged(result, label, binary, args, options = {}) {
    try {
      const output = await command(binary, args, { signal: this.signal, ...options });
      result.evidence.push(await this.run.evidence(`${label}.log`, output.stdout + output.stderr));
      return output;
    } catch (error) {
      result.evidence.push(
        await this.run.evidence(`${label}.log`, `${error.stdout ?? ''}${error.stderr ?? ''}\n${error.message}`),
      );
      throw error;
    }
  }

  compose(args, options = {}) {
    return command('docker', ['compose', '-p', this.id, '-f', this.file, ...args], { signal: this.signal, ...options });
  }

  composeRun(result, label, args, options) {
    return this.logged(result, label, 'docker', ['compose', '-p', this.id, '-f', this.file, ...args], options);
  }

  execSql({ service, user, db }, query) {
    return this.compose(['exec', '-T', service, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', user, '-d', db, '-At'], {
      input: query,
    });
  }

  /**
   * Generic git-archive snapshot of a committed revision into `this.source`.
   *
   * Behavior is byte-identical to DAD's original inline snapshot; only the
   * required-files list and its error message are injected by the caller so the
   * DAD-specific text stays with the DAD subclass. `source` (the candidate
   * `source` field) is also supplied by the caller (DAD: `sourceIdentity ?? repo`).
   *
   * @param {object} result
   * @param {object} options
   * @param {string[]} options.requiredFiles           Tracked files that must exist in the revision.
   * @param {(file: string) => string} options.requireMessage  Error message for a missing required file.
   * @param {string} options.source                    Value recorded as `candidate.source`.
   */
  async snapshot(result, { requiredFiles, requireMessage, source }) {
    const { stdout } = await command('git', ['rev-parse', '--verify', `${this.revision}^{commit}`], {
      cwd: this.repo,
      signal: this.signal,
    });
    const revision = stdout.trim();
    if (!/^[a-f0-9]{40,64}$/.test(revision)) throw new RunError('Invalid source revision.');
    const tree = await command('git', ['ls-tree', '-r', '--name-only', revision], {
      cwd: this.repo,
      signal: this.signal,
    });
    const files = tree.stdout.trim().split('\n');
    if (files.some(f => /(^|\/)\.env(?:\.|$)/.test(f) && !f.endsWith('.example')))
      throw new RunError('Snapshot refuses tracked environment files containing potential credentials.');
    for (const file of requiredFiles) {
      if (!files.includes(file)) throw new RunError(requireMessage(file));
    }
    await mkdir(this.source, { mode: 0o700 });
    const archive = path.join(this.run.dir, 'source.tar');
    await command('git', ['archive', '--format=tar', `--output=${archive}`, revision], {
      cwd: this.repo,
      signal: this.signal,
    });
    await command('tar', ['-xf', archive, '-C', this.source], { signal: this.signal });
    const changes = await command('git', ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', revision], {
      cwd: this.repo,
      signal: this.signal,
    });
    const worktree = await command('git', ['status', '--porcelain'], { cwd: this.repo, signal: this.signal });
    this.run.data.candidate = {
      revision,
      sourceArchiveSha256: digest(await readFile(archive)),
      source,
      changedFiles: changes.stdout.trim().split('\n').filter(Boolean).slice(0, 500),
      excludesWorkingTreeChanges: true,
      workingTreeDirty: Boolean(worktree.stdout.trim()),
    };
    result.evidence.push(await this.run.evidence('candidate.json', JSON.stringify(this.run.data.candidate, null, 2)));
    return {
      summary: `Archived committed revision ${revision.slice(0, 12)}; working tree and environment files excluded.`,
    };
  }

  /**
   * Generic image build+inspect helper. Takes an already-resolved list of build
   * specs so the DAD-specific, mode-conditional `*-checks` branching stays in the
   * subclass. Each spec is logged via `logged` under its own label; the mapping
   * recorded on the candidate is keyed by the inspect `service`/`image` pairs.
   *
   * @param {object} result
   * @param {Array<{label: string, args: string[], options?: object}>} builds
   *   Build invocations; each becomes `docker build ...args` logged under `label`.
   * @param {Array<{service: string, image: string}>} [inspects]
   *   Image references to inspect; `run.data.candidate.images[service] = <image id>`.
   */
  async buildImages(result, builds, inspects = []) {
    for (const { label, args, options } of builds) {
      await this.logged(result, label, 'docker', ['build', ...args], options);
    }
    if (inspects.length) {
      this.run.data.candidate.images = {};
      for (const { service, image } of inspects) {
        const inspected = await command('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], {
          signal: this.signal,
        });
        this.run.data.candidate.images[service] = inspected.stdout.trim();
      }
    }
  }

  /** Compose `up -d --wait` wrapper (evidence-emitting via composeRun). */
  up(result, label, services, { waitTimeout = '90', options } = {}) {
    return this.composeRun(result, label, ['up', '-d', '--wait', '--wait-timeout', waitTimeout, ...services], options);
  }

  /** Compose `down` teardown wrapper (evidence-emitting via composeRun). */
  down(result, label = 'cleanup', options = { timeout: 90_000 }) {
    return this.composeRun(result, label, ['down', '--volumes', '--remove-orphans', '--timeout', '10'], options);
  }

  /**
   * Generic cleanup flow: best-effort tail-log collection (swallowing errors),
   * then `down --volumes --remove-orphans`, else a no-op `cleanup.log`. The
   * log-collection service list and the "nothing created" message are supplied
   * by the caller so DAD's exact strings stay with DAD.
   *
   * @param {object} result
   * @param {object} options
   * @param {string[]} options.logServices   Services whose tail logs are collected best-effort.
   * @param {string} options.logLabel        Evidence filename (without `.log`) for collected logs.
   * @param {string} options.emptyMessage    `cleanup.log` body when nothing was created.
   */
  async cleanupFlow(result, { logServices, logLabel, emptyMessage }) {
    if (this.created) {
      // Cleanup gets its own deadline and is not canceled with the run.
      try {
        const logs = await this.compose(['logs', '--no-color', '--tail', '150', ...logServices], {
          timeout: 20_000,
        });
        result.evidence.push(await this.run.evidence(`${logLabel}.log`, logs.stdout + logs.stderr));
      } catch {
        /* Removal must still run if log collection fails. */
      }
      await this.down(result);
    } else {
      result.evidence.push(await this.run.evidence('cleanup.log', emptyMessage));
    }
  }
}
