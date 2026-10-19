# Move 3 design — adapter split: generic provisioning core + `targets/dad` + formal target-adapter interface

Branch `feat/adapter-interface` (worktree `.worktrees/move3-adapter-split`). ESM, Node ≥ 22, Biome-clean (`npm run lint` = `biome check --error-on-warnings .`). This is a design doc only; no code is written in this step.

## Overview

Move 2 already built the dependency-injection seam: a `src/targets.js` registry (`resolveTarget`/`isRegisteredAdapter`), `executeDiscovery(repo, { target })` resolving an `adapterFactory`, a second in-process adapter (`src/benchmark-adapter.js`), a parameterized discovery cookie name (`who.cookieName ?? 'dad_donor_session'`), and a relaxed policy adapter check. Move 3 does **not** redo any of that. Move 3 takes the one remaining monolith — the DAD-coupled `DadAdapter` in `src/dad.js` — and (a) extracts its generic Docker/compose/git provisioning machinery into a reusable base, (b) relocates everything DAD-specific into a `src/targets/dad/` package, (c) writes down the **formal target-adapter interface** the runner already calls de-facto, and (d) proves that interface generalizes by validating it against two genuinely different adapters that already exist (`dad` over Docker/Postgres; `benchmark` in-process, no Docker).

The hard constraint governs every decision: **the DAD target stays byte-identical** in behavior and emitted identifiers. The refactor is a pure reorganization plus documentation — no observable DAD output changes, and the identifiers `impactgraph-discovery` / `impactgraph` and the cookie `dad_donor_session` are preserved verbatim (they are intentional compatibility aliases, never to be renamed).

The discovery **engine** (`discovery.js`, `discovery-browser.js`, `experiments.js`, `experiment-contract.js`, `application-memory.js`, `source-reader.js`, `core.js`, `model-provider.js`) needs essentially no change; §7 lists the one tiny optional thread-through the formalization exposes.

## 1. The formal discovery target-adapter interface

This is the contract `executeDiscovery` (`src/discovery-runner.js`) relies on today. It is extracted verbatim from the runner's actual call sites — not invented — and written down so a third party can implement a target without reading the runner. The interface is documented as a JSDoc `@typedef` block plus prose in `src/targets/base.js` (the home of the shared contract); adapters are plain classes that structurally satisfy it (duck-typed, no `implements`, consistent with the current ESM/no-TS codebase).

### Lifecycle and ordering guarantees the runner provides

The runner drives a fixed phase order and owns the per-phase `AbortSignal`. An adapter may rely on all of this:

1. **Construction.** `adapterFactory(run, { repo, revision, signal })` is called once. `run` is a `Run` (evidence dirs, `run.dir`, `run.data`, `run.evidence(name, text)`, `run.reference(path)`). The **discovery** runner passes exactly `{ repo, revision, signal }` from `executeDiscovery`; the **acceptance** runner (`src/runner.js:47`) additionally sets an `sourceIdentity` **property on the same single options object** (`new DadAdapter(run, { repo, revision, sourceIdentity, signal })` — not a positional 4th argument), which DAD validates and which discovery leaves `undefined` (see note in §2). The discovery interface therefore requires only the three-property options form (`{ repo, revision, signal }`); `sourceIdentity` is a DAD-only extra property on the options object, not part of the formal contract.
2. **Provisioning phases, in this exact order:** `snapshot` → `docker` → `build` → `database` → `deploy`. The runner calls `adapter[id](result)` for each. If any returns a falsy "ready" value or the outer `signal` aborts, the chain stops and remaining phases are recorded as `inconclusive`/`canceled`.
3. **Discovery phase.** After `deploy` succeeds, the runner reads getters/calls fixture methods (below), builds application memory + source inventory, opens the browser against `adapter.publicOrigin`, and runs `discover(...)`.
4. **Cleanup always runs.** `adapter.cleanup(result)` is invoked in a `finally`, even on failure/abort/exception in any earlier phase. It must tolerate being called when little or nothing was provisioned.

**Signal discipline (owned by the runner, per `step()`):** before each provisioning phase and before discovery the runner sets `adapter.signal = AbortSignal.any([outerSignal, AbortSignal.timeout(check.timeoutMs)])`. For **cleanup only**, `adapter.signal = AbortSignal.timeout(cleanupBudget)` — cleanup is deliberately **not** canceled by the outer run signal so teardown still runs after a cancel. The adapter must read `this.signal` fresh at the start of each method (DAD does: every `command(...)` passes `{ signal: this.signal }`). The discovery phase additionally composes `AbortSignal.any([adapter.signal, AbortSignal.timeout(discoveryLimits.durationMs)])` for the browser/agent; the adapter does not manage that.

### Required methods

Each provisioning method takes the per-phase `result` object (has `result.evidence` array; the adapter appends evidence via `result.evidence.push(await run.evidence(name, text))` or `await run.reference(path)`), returns `{ summary: string }` (or a falsy value / throws to signal "not ready"), and must emit the evidence filenames the policy's `evidenceRequirements` mandates for that phase (`policy.js`): `snapshot`→`candidate.json`; `docker`→`docker.log`,`compose-version.log`; `build`→`build-api.log`,`build-web.log`; `database`→`migrations.log`,`test-migrations.log`; `deploy`→`readiness.log`; `cleanup`→`cleanup.log`. (The evidence-filename contract is itself DAD-shaped; benchmark satisfies it with "not applicable" logs. Move 3 keeps this contract as-is — relaxing it is out of scope, see §8.)

- `snapshot(result) → {summary}` — materialize the candidate under test and set `run.data.candidate` (must include at least `{ revision, source }`; DAD adds `sourceArchiveSha256`, `changedFiles`, dirty flags, later `images`). Writes `candidate.json`.
- `docker(result) → {summary}` — provisioning readiness; for DAD: allocate free port, set `publicOrigin`, generate run-local credentials, write compose file + nginx config, record `run.data.environment`. For non-Docker targets this is a no-op that still writes the two log files.
- `build(result) → {summary}` — build/prepare runnable artifacts (DAD: build+inspect images).
- `database(result) → {summary}` — bring up data stores + run migrations/role setup (DAD: compose up postgres, migrate, create roles).
- `deploy(result) → {summary}` — start the app and assert health against `publicOrigin` (DAD: compose up api/web/ingress + HTTP 200 check).
- `cleanup(result) → {summary}` — tear down everything provisioning created. **Always called.** Must be idempotent/safe when nothing was created (DAD guards on `this.created`).

### Required getters/fields read by the discovery phase

- `adapter.publicOrigin: string` — the loopback origin the browser drives. Set during provisioning (DAD in `docker`, benchmark in `snapshot`). **Must** pass `openDiscoveryBrowser`'s guard: `http:` protocol, host `localhost` or `127.0.0.1`, an explicit port, pathname exactly `/`, no userinfo. Available by the time discovery starts.
- `adapter.signal: AbortSignal` — writable; the runner assigns it per phase (above). The adapter reads it; it does not create it.
- `adapter.discoveryFixture() → Promise<Actor[]> | Actor[]` — **required.** Provisions synthetic identities and returns actor descriptors (shape below). DAD runs fixture SQL and returns 3 actors; benchmark maps its in-process app's actors.

**Actor descriptor shape** (consumed by `discovery-runner.js` and `discovery-browser.js`):
```
{
  id:          string,   // required, stable actor id (e.g. 'guest', 'donor-a')
  description: string,   // required, human/agent-facing summary
  entry:       string,   // required, loopback-relative entry path (e.g. '/', '/account/dashboard')
  cookie?:     string,   // optional, session cookie VALUE; omit for anonymous actors
  cookieName?: string    // optional, cookie NAME; only meaningful with `cookie`
}
```
The browser's `bootstrap()` sets a cookie iff `who.cookie` is present, using `who.cookieName ?? 'dad_donor_session'` (Move 2's seam). DAD's two authenticated donors carry `cookieName: 'dad_donor_session'`; benchmark's carry `cookieName: 'session'`; anonymous `guest` carries neither. Note the two `cookieName`s are not equivalently load-bearing: DAD's app matches the cookie by name, so `dad_donor_session` is functionally required, whereas `discovery-benchmark.js` authenticates by a cookie-*value* substring check (`request.headers.cookie?.includes('test-a' | 'test-b')`) regardless of name — benchmark's `cookieName: 'session'` is cosmetic and exists only to exercise Move 2's `cookieName ?? …` seam with a non-default value. The formal contract treats `cookieName` as an opaque optional string; it does not mandate a value. The runner also projects `{ id, description, entry }` into the report and `{ id, description }` into observations, so those three fields are mandatory for every actor.

### Optional getters/methods (runner degrades gracefully)

- `adapter.discoveryReplayFixture() → Promise<Fixture> | Fixture | undefined` — **optional.** The runner calls it **only if the property exists** (`adapter.discoveryReplayFixture ? await adapter.discoveryReplayFixture() : undefined`). A `Fixture` exposes optional `{ replay(): Promise<restore>, inspect(): Promise<state> }` (see `discovery-fixture.js`/`replayFixture`). When absent or partial, `discovery-browser.js` degrades: `capabilities.cleanFixtureReplay`/`persistedState` go false, mutations are observed-only, reproduction runs read-only. DAD returns a full replay fixture (gated on exploration mode + run-owned db); benchmark returns an in-process fixture with `inspect`.
- `adapter.source: string | undefined` — **optional.** Absolute path to a source root for `sourceReader(adapter.source)`. The runner calls the reader only when `adapter.source` is set; otherwise source inspection is disabled (`capabilities.sourceInspection = false`). Must point at a directory the sandboxed reader can inventory (committed archive for DAD; synthetic files written under `run.dir/source` for benchmark). Both current adapters set `this.source = path.join(run.dir, 'source')`.

### Not part of the discovery interface

Everything in §2 (`invitation`, `verifyStaff`, `donorFixture`, `verifyDonor`, `performanceFixture`, `suite`, `discoveryState`, `sql`) is **not** in this contract. `discoveryState()` is called only indirectly, as the `inspect` callback DAD passes **into its own** `replayFixture(...)`; the runner never calls it. Adapters MAY expose extra methods; the formal contract is the minimum the runner consumes.

## 2. DAD-validation-only methods (stay with DAD, not in the generic contract)

These serve the deterministic acceptance pipeline (`src/runner.js`) and/or are DAD-internal helpers. They must remain on the DAD adapter and must **not** be pushed into `base.js` or the formal interface:

- `invitation()` — staff bootstrap; parses a run-scoped activation URL. Used by `staffJourney`.
- `verifyStaff()` — read-only SQL assertion of persisted staff/passkey/session invariants.
- `donorFixture()` / `verifyDonor({signedOut})` — donor claim-link fixture + read-only SQL verifier for the donor-claim journey.
- `performanceFixture()` — synthetic load fixture (12 donors × 60 gifts), returns `dad_donor_session=` cookies for `performanceCheck`.
- `suite(result, name)` — runs the `api-tests`/`web-tests` compose services (deterministic acceptance only).
- `discoveryState()` — fixed read-only projection over the DAD schema; wired only as the `inspect` callback inside DAD's `discoveryReplayFixture`.
- `sql(query)` — DAD psql-exec helper (`compose exec -T postgres psql … dad_atm`). DAD-specific connection details; DAD-internal.

`runner.js` constructs `new DadAdapter(...)` directly and calls these; that path is byte-unchanged by Move 3 except for the import source moving to the new DAD package (§3). Note the discovery constructor only ever receives `{ repo, revision, signal }`; `sourceIdentity` is read by DAD for the `runner.js` path and simply stays `undefined` under discovery — unchanged.

## 3. Target directory layout

Proposed layout (new files unless noted):

```
src/targets/
  index.js        # registry: targets, resolveTarget, isRegisteredAdapter  (moved from src/targets.js)
  base.js         # ProvisioningAdapter base class + the formal-interface JSDoc typedefs + shared helpers
  benchmark.js    # BenchmarkAdapter, relocated from src/benchmark-adapter.js
  dad/
    index.js      # DadAdapter (extends ProvisioningAdapter) + re-exports composeDefinition
    config.js     # DAD config object: images, required files, env names, db/roles, compose topology, cookie name
    compose.js    # composeDefinition(...) + nginx template (moved from dad.js)
    sql.js        # DAD fixture/projection/verification SQL builders (donors, donor_sessions, donor_gifts, …)
```

### Import-compatibility decision (hard requirement — tests import deep paths)

Tests import `{ DadAdapter, composeDefinition } from '../src/dad.js'`, `{ BenchmarkAdapter } from '../src/benchmark-adapter.js'`, and `{ resolveTarget, isRegisteredAdapter }` from `../src/targets.js`; `runner.js`/`cli.js`/`policy.js`/`discovery-runner.js` import `./targets.js` and `./dad.js`. To keep the DAD path byte-identical and the suite green **without editing byte-identical-sensitive call sites**, the plan is:

- **Update the production importers that touch the *registry* path** — `discovery-runner.js`, `cli.js`, and `policy.js` (which import `./targets.js`) — to `./targets/index.js`. These are mechanical import-path edits with zero behavioral change.
- **Leave `src/runner.js` unchanged.** It imports `{ DadAdapter } from './dad.js'` (confirmed at `runner.js:4`), and the `src/dad.js` shim below re-exports `DadAdapter` from the new DAD package, so `runner.js` resolves the identical class with **zero changed lines**. This is deliberate: the byte-identical-sensitive acceptance pipeline file is not edited at all, which is a strictly stronger proof than a one-line import change. (The alternative — repointing `runner.js` at `./targets/dad/index.js` for one changed line — is rejected here to keep that file's diff empty; the design standardizes on "zero lines" and §4 is written to match.)
- **Keep thin compatibility shims** at the three old module paths so no test import *and no `runner.js` import* has to change in this move:
  - `src/targets.js` → `export * from './targets/index.js';`
  - `src/dad.js` → `export { DadAdapter } from './targets/dad/index.js'; export { composeDefinition } from './targets/dad/compose.js';`
  - `src/benchmark-adapter.js` → `export * from './targets/benchmark.js';`
  
  Chosen over "rewrite every test import" because it keeps the diff minimal and the risk of accidentally perturbing DAD behavior near zero; the shims are trivial re-exports. (Alternative — delete the old files and update ~5 test imports — is also viable and can be done as a tidy-up, but is not required for correctness and widens the diff. Recommend keeping shims this move; a later cosmetic move can drop them.)

**Import graph (confirmed acyclic — ESM circular re-exports can surface as `undefined` named exports at load, so the graph is walked explicitly).** Every edge points "downward" from shims → registry → adapters → leaf modules; no module imports a shim:
- `src/targets.js` (shim) → `src/targets/index.js`
- `src/dad.js` (shim) → `src/targets/dad/index.js`, `src/targets/dad/compose.js`
- `src/benchmark-adapter.js` (shim) → `src/targets/benchmark.js`
- `src/targets/index.js` → `src/targets/dad/index.js`, `src/targets/benchmark.js`
- `src/targets/dad/index.js` → `src/targets/base.js`, `src/targets/dad/config.js`, `src/targets/dad/compose.js`, `src/targets/dad/sql.js`
- `src/targets/benchmark.js` → (its current deps only; it does **not** extend `base.js`)
- leaves (`base.js`, `dad/config.js`, `dad/compose.js`, `dad/sql.js`) import no `targets/*` sibling upward and no shim.

Production consumers import downward too: `runner.js → src/dad.js` (shim); `discovery-runner.js`, `cli.js`, `policy.js → src/targets/index.js`. **Rule to enforce during implementation:** no file under `src/targets/` may import `../targets.js`, `../dad.js`, or `../benchmark-adapter.js` (the shims) — they import the real modules directly. With every edge downward and no shim consumed internally, the graph is a DAG, so no circular-re-export `undefined`-export hazard exists.

### Composition over inheritance — recommendation

**Recommend a thin base class (`ProvisioningAdapter`) that owns cross-cutting run bookkeeping + the subprocess/compose/git helpers, with DAD composing a plain `DAD_CONFIG` object for all target-specific values.** Rationale: the genuinely shared, stateful machinery (the `logged` evidence-wrapping helper, `created`/`id` bookkeeping, `signal` handling, free-port allocation, git archive) is naturally expressed as methods on a base that both the real DAD adapter and any future Docker target reuse; a class keeps `this.signal`/`this.run`/`this.created` co-located the way the code already works. But the **behavioral differences stay in config/data, not subclass overrides** — DAD passes a config object (service names, env var names, db name, roles, required files, cookie name, SQL builders) into the base helpers rather than overriding methods. This is "inheritance for the mechanics, composition for the policy," which matches the existing style (the adapter is already a single class holding helpers + state) and avoids a deep override hierarchy that would make the byte-identical proof harder. The benchmark adapter does **not** extend the base (it has no Docker/git machinery to share) — it stays a standalone class that satisfies the duck-typed interface, exactly as today. That asymmetry is the point: the base is a convenience for provisioning targets, not a mandated superclass; the *interface* (§1) is the real contract.

### Generic machinery to extract into `base.js`

Lift from `DadAdapter`, unchanged in behavior, parameterized by config where DAD specifics appear:

- `freePort()` — module-level helper in `dad.js` today; move to `base.js`, export for reuse.
- `logged(result, label, binary, args, options)` — evidence-wrapping subprocess runner (success and failure both write `${label}.log`). Pure mechanics; move to base.
- `compose(args, options)` — the existing `command('docker', ['compose', '-p', this.id, '-f', this.file, ...args], { signal: this.signal, ...options })` wrapper (`dad.js:162-164`). The `docker`/`compose` binary and the `-p id`/`-f file` convention are generic; service names/args are supplied by callers. Move to base verbatim, driven by `this.id`/`this.file`. All existing `this.compose([...])` call sites (`sql`, the migrate/health-exec reads, the deploy `up` wrappers, the cleanup `logs`) already route through this method and are a pure relocation — the argv is unchanged because the method body is unchanged.
- **`composeRun(result, label, args, options)` — new base helper that captures the *inlined* compose+`logged` call sites.** This is the concrete rule finding #1 demands, because `database`, `deploy`, `suite`, and `cleanup`'s teardown do **not** call `this.compose(...)` today — they inline the full argv straight into `logged`, e.g. `this.logged(result, 'database-start', 'docker', ['compose','-p',this.id,'-f',this.file,'up','-d','--wait','--wait-timeout','90','postgres', …])` (label `'database-start'`, `dad.js:299`), label `'migrations'` (`:315`), label `'test-migrations'` (`:327`), `suite`'s `name` (`async suite`, `:358`), label `'deploy'` (`:373`), and `cleanup`'s `'down'` (`:588`). (Line numbers are against the current worktree; the label strings are unique and greppable, so they are the authoritative locators if the lines drift.) The base helper is defined to prepend **exactly** `['compose', '-p', this.id, '-f', this.file]` and then append `args` verbatim, forwarding `label`/`options` to `logged` unchanged:

  ```js
  composeRun(result, label, args, options) {
    return this.logged(result, label, 'docker', ['compose', '-p', this.id, '-f', this.file, ...args], options);
  }
  ```

  **Rewrite rule (binding):** each inlined call `this.logged(result, LABEL, 'docker', ['compose','-p',this.id,'-f',this.file, ...REST], OPTS)` becomes `this.composeRun(result, LABEL, [...REST], OPTS)` where `REST` is copied **character-for-character** (including the embedded `...(mode === 'exploration' ? [] : ['test-postgres'])` spread in `database-start` and the templated `-e DONOR_GO_DATABASE_URL=…` string in `test-migrations`, which stay in the DAD method and are passed through as elements of `REST`). The constraint is: for every rewritten call, the flattened argv array after the helper prepends `['compose','-p',this.id,'-f',this.file]` must equal the pre-refactor inlined array **element-for-element**. Because the only transformation is "move the four fixed leading elements into the helper," this is provably an identity on the emitted argv. This is a behavioral-source rewrite of the argv call sites, not a textual relocation — so it is explicitly guarded (§4, §8.6) rather than assumed.
- git archive/snapshot of a revision into a temp workdir — `rev-parse` verify, `.env` refusal, `ls-tree`, `git archive` → `tar -x` into `this.source`, `diff-tree`/`status` for candidate metadata. The **generic** skeleton (resolve revision, archive, extract, compute `sourceArchiveSha256`, assemble candidate bookkeeping) moves to base; the **DAD-specific required-files list** stays in config (§ below).
- image build + inspect loop — the generic "build these [service,dockerfile] pairs, then `docker image inspect --format {{.Id}}`" shape can be a base helper taking the service/dockerfile/build-arg config; DAD's specific services/build-args come from config. **The mode-conditional branching is DAD-specific and does NOT move into the base helper** (see the explicit note below).
- compose up/down lifecycle (`up -d --wait`, `run --rm`, `stop`, `down --volumes --remove-orphans`) — these are reached through `compose(...)` (for the no-evidence reads like the deploy `stop`/`up` in the replay fixture) or `composeRun(...)` (for the evidence-emitting phases). The base owns the two wrappers; which services, timeouts, and labels come from the caller/config, copied verbatim per the rewrite rule above.
- **SQL-exec helper plumbing — base provides a generic `execSql({ service, user, db }, query)` whose argv is pinned element-for-element to DAD's current `sql` invocation (`dad.js:291-295`), with ONLY `service`/`user`/`db` parameterized.** The real argv is `['exec','-T','postgres','psql','-X','-v','ON_ERROR_STOP=1','-U','atm_owner','-d','dad_atm','-At']`, and `-X -v ON_ERROR_STOP=1` are load-bearing (they disable `psqlrc` and abort on the first SQL error — the role-creation `CREATE USER … GRANT …`, `verifyStaff`, `verifyDonor`, `discoveryState`, the fixtures, and replay restore all depend on `ON_ERROR_STOP=1`). They must NOT be dropped, reordered, or collapsed into the `…` of a sketch. The helper is defined exactly:

  ```js
  execSql({ service, user, db }, query) {
    return this.compose(
      ['exec', '-T', service, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', user, '-d', db, '-At'],
      { input: query },
    );
  }
  ```

  DAD's `sql(query)` becomes `execSql({ service: 'postgres', user: 'atm_owner', db: 'dad_atm' }, query)`. **Invariant (binding):** the flattened argv after `compose` prepends `['compose','-p',this.id,'-f',this.file]` and the helper binds `service/user/db` must equal the pre-refactor `sql` argv **element-for-element** — the only transformation is "parameterize the three fixed values," which is provably an identity on the emitted argv. This path routes through `compose(...)` (not `composeRun`), so it is a distinct byte-identical-sensitive argv that §8.6(b) must guard separately (it does — see the `sql`/exec case added there).
- `created`/`id` run bookkeeping — base constructor sets `this.run`, `this.id = run.data.id`, `this.signal`, `this.created = false`; `database`/`cleanup` flip/consult `this.created`.
- cleanup of containers/volumes/workdir — the generic "collect tail logs (best-effort via `compose(['logs', …])`, swallowing errors) then `composeRun(result, 'cleanup', ['down','--volumes','--remove-orphans','--timeout','10'], { timeout: 90_000 })`, else write the no-op `cleanup.log`" flow moves to base; DAD passes the service list (`api`, `web`, `ingress`) for log collection. The `down` argv after prepend equals the current inlined `['compose','-p',this.id,'-f',this.file,'down','--volumes','--remove-orphans','--timeout','10']` element-for-element.

### DAD-specific config/behavior to move into `src/targets/dad/`

Into `dad/config.js` (data) and `dad/compose.js`/`dad/sql.js` (builders), consumed by `dad/index.js`:

- **Exploration-vs-acceptance mode branching stays verbatim in `dad/index.js`, NOT in the base helper.** DAD's `build()` and `database()` methods emit mode-conditional artifacts that the base generic helpers must not absorb: when `this.run.data.options.mode !== 'exploration'`, `build()` also builds the `*-checks` images (`build-api-checks.log` / `build-web-checks.log`, `--target build -t ${id}/${service}-checks:local`, `dad.js:264-272`) and `database()` brings up `test-postgres` in `database-start` (the `mode === 'exploration' ? [] : ['test-postgres']` spread at `dad.js:311`), runs the `test-migrations` migrate pass with `DONOR_GO_DATABASE_URL=…@test-postgres/donor_go` (`dad.js:326-349`), and emits a real `test-migrations.log`; under exploration mode `database()` instead writes the fixed string `test-migrations.log` → `'Not applicable: exploration uses only the application database.'` and skips `test-postgres`, and the `build`/`database` summary strings differ by mode. All of this branching, including the two summary-string variants, moves character-for-character into `dad/index.js`; the base `buildImages`/compose helpers see only the already-resolved service list the DAD method passes in. This is why these artifacts are not in the formal §1 required-evidence set (that set is the policy-mandated minimum; the `*-checks`/`test-postgres` artifacts are DAD-mode extras).
- Required-files check: `apps/donor-api/Dockerfile`, `apps/web/Dockerfile`, `apps/web/package-lock.json`.
- Pinned base images `POSTGRES`, `NGINX` (digest-pinned constants).
- Compose topology/service names: `postgres`, `test-postgres`, `migrate`, `api`, `web`, `ingress`, `staff`, `api-tests`, `web-tests`; the whole `composeDefinition(...)` builder and the nginx `default.conf` template.
- Env var names: `DONOR_PUBLIC_ORIGIN`, `DONOR_STAFF_ORIGIN`, `DONOR_GO_WORKERS_ENABLED`, `DONOR_API_DATABASE_URL`, `DONOR_GO_DATABASE_URL`, `DONOR_STAFF_CLI_DATABASE_URL`, `DONOR_API_BASE_URL`, `TEST_DATABASE_URL`, and the `DONOR_PUBLIC_ORIGIN`/`DONOR_STAFF_ORIGIN` web build-args.
- DB name `dad_atm` (and integration `donor_go`); roles `dad_api` → `atm_api`, `dad_staff_cli` → `atm_staff`; owner `atm_owner`.
- Ingress/nginx proxy specifics (`proxy_pass http://web:3000`, headers).
- Discovery fixture/state/replay SQL over `donors`, `donor_sessions`, `donor_checkouts`, `donor_gifts`, `donor_metric_projections`, `donor_preferences`; the staff/donor verification SQL; `performanceFixture` SQL.
- Cookie name `dad_donor_session` (both the actor-descriptor value in `discoveryFixture` and the `performanceFixture` cookie string).
- The validation-only methods from §2.

## 4. How DAD stays byte-identical, and how each invariant is proven

The refactor moves code between files and introduces a base class; it changes **no** DAD runtime string, SQL statement, compose field, identifier, or control-flow. Invariants and proofs:

| Invariant | How preserved | How proven |
|---|---|---|
| Policy id stays `impactgraph-discovery` | `targets/index.js` keeps DAD's `policyId: 'impactgraph-discovery'` verbatim (moved registry entry, unchanged value) | Existing Move 2 test asserting `discoveryPolicy('dad').definition.id === 'impactgraph-discovery'`; still green. |
| Adapter id stays `impactgraph` | Registry `adapterId: 'impactgraph'` unchanged; `Run.create` still records `adapter: resolved.adapterId` | Move 2 registry/identity tests; `runner.js` still writes `adapter:'impactgraph'`. |
| `discoveryPolicy('dad')` digest **and** full JSON equal pre-refactor | `discoveryPolicy` reads id/adapter from the (moved but value-identical) registry; `hashPolicy` input unchanged | Two guards in `test/targets.test.js`, both comparing against **frozen literals captured from `dev` before any Move 3 edit** (not re-derived from the refactored branch, which would be tautological): (a) `assert.equal(discoveryPolicy('dad').digest, '<pinned digest>')` with the pinned value `be91648ac06f7508faf9148c339d25e0a704f4b7c61c7918b8e7b23892113954` (captured via `node -e "import('./src/discovery-runner.js').then(m=>console.log(m.discoveryPolicy('dad').digest))"` on `dev`); (b) `assert.equal(JSON.stringify(discoveryPolicy('dad').definition), EXPECTED_DAD_POLICY_JSON)` where `EXPECTED_DAD_POLICY_JSON` is the exact 869-char string in §8.6, pasted as a literal constant. The pre-existing `digest === discoveryPolicy().digest` relative check is kept as a third assertion. See §8.6 for the capture procedure and the literal body. |
| DAD cookie stays `dad_donor_session` | Value moves to `dad/config.js` but the literal is unchanged; browser default remains `?? 'dad_donor_session'` | Existing `adapter.test.js` "discovery fixture authenticates donors with the dad_donor_session cookie name" (both authenticated donors, guest none). |
| `composeDefinition` output byte-identical | The function body moves to `dad/compose.js` unchanged; no field reordering | Existing `adapter.test.js` isolation assertions (ports, networks.isolated.internal, absent integration env, db URLs) still pass against the re-exported `composeDefinition`. |
| DAD verifiers unchanged (`verifyDonor`, `discoveryState`, `discoveryFixture`) | SQL builders move to `dad/sql.js` as the identical strings; methods call them | Existing `adapter.test.js` donor-verifier cases and `experiments.test.js` "DAD adapter verifier selects only synthetic identities…" (asserts `BEGIN READ ONLY`, `explorer-a@atm.invalid`, no `token_hash`, replay refuses non-run-owned db). |
| `sql`/exec psql argv byte-identical (incl. `-X -v ON_ERROR_STOP=1`) | `sql(query)` → `execSql({ service:'postgres', user:'atm_owner', db:'dad_atm' }, query)`; the base helper pins `['exec','-T',service,'psql','-X','-v','ON_ERROR_STOP=1','-U',user,'-d',db,'-At']` with only `service`/`user`/`db` parameterized (§3) | **New** §8.6(b) compose-argv guard: drive `DadAdapter.sql('SELECT 1')` with a stubbed `command`, assert the recorded argv equals the pinned literal element-for-element. This is the only guard covering the `compose(...)` (non-`composeRun`) exec path — a dropped/reordered `-X`/`-v`/`ON_ERROR_STOP=1` flag fails it loudly. |
| DAD validation pipeline (`runner.js`) behaves identically | `runner.js` keeps `import { DadAdapter } from './dad.js'`; the `src/dad.js` shim re-exports the relocated class, so the import, call sequence, and method bodies are all unchanged | Deterministic-pipeline tests remain green; `git diff dev...feat/adapter-interface -- src/runner.js` is **empty** (zero changed lines). |
| `src/runner.js` validation logic unchanged | The validation this file owns is **not** touched: the `policy.definition.scope !== 'local-acceptance'` guard (rejecting the explore path), the hardcoded `adapter: 'impactgraph'` literal passed to `Run.create`, the `required`/`checks` derivation, the per-step `deadline`/`signal` wiring, the `new DadAdapter(run, { repo, revision, sourceIdentity, signal })` construction, and the `ai-public-journey` model gate. Because `runner.js` is pinned to the `./dad.js` shim (§3), **no line in this file changes** | `git diff dev...feat/adapter-interface -- src/runner.js` shows **zero changed lines** — the scope guard, the `'impactgraph'` literal, the `new DadAdapter(run, { repo, revision, sourceIdentity, signal })` options-object construction, and all control flow are byte-identical; the deterministic-pipeline unit tests that exercise this path stay green. |
| Old import paths keep working | Shim re-exports at `src/dad.js`, `src/benchmark-adapter.js`, `src/targets.js` (§3) | Whole unit suite (`npm test`, 107+ pass with keys unset, no Docker) resolves and passes without editing test imports. |

The `impactgraph` strings are **intentional compatibility aliases** and are copied, never renamed. The byte-identical bar is: `git diff dev...feat/adapter-interface` shows DAD *runtime* bytes relocated, not altered; policy digest/JSON, cookie, compose output, and SQL are proven equal by the tests above.

## 5. Edge cases & error handling

The refactor inherits DAD's existing, already-tested error handling; the design keeps each failure path intact and places it in the right layer:

- **Subprocess failure (`logged` in base):** on throw, still writes `${label}.log` capturing `stdout+stderr+message`, then rethrows. Recoverable vs fatal is decided by the phase: build/database/migrate failures use `{ failureStatus: 'failed' }` so `run.step` records `failed` (not merely inconclusive); the runner stops the provisioning chain. Logged at evidence level (the `.log` file); not re-logged to stdout.
- **Invalid revision / snapshot refusals (base git skeleton):** `rev-parse` non-40–64-hex → `RunError('Invalid source revision.')`; tracked `.env` (non-`.example`) → `RunError('Snapshot refuses tracked environment files…')`; missing a DAD required file (from config list) → `RunError('DAD adapter requires <file>.')`. All fatal for the run, surfaced as the `snapshot` step result; the required-files list lives in DAD config so other targets supply their own (or none).
- **`publicOrigin` guard (browser):** if an adapter sets a non-loopback/non-`/` origin, `openDiscoveryBrowser` throws `'Discovery requires a run-owned loopback origin.'` — fatal for discovery, caught by the discovery phase's try/catch and reported as `inconclusive`. This guard is the enforcement point for the `publicOrigin` validation rule; the adapter is trusted to produce it but the browser re-validates (defense in depth).
- **Deploy health check:** DAD's `deploy` throws `RunError` on non-200 ingress; fatal, stops before discovery.
- **Replay fixture gating (DAD):** `discoveryReplayFixture` throws `RunError('Fixture replay requires a run-owned exploration database.')` unless mode is exploration, `this.created`, and `this.id` matches `atm-<14digits>-<8hex>`. If replay/restore later fails, `discovery-browser` sets `replayUnavailable` and aborts further experiments. The runner's optional-call guard means a target with no replay simply runs observed-only.
- **Cleanup robustness:** `cleanup` runs under its own timeout signal (not the run signal), collects tail logs best-effort (swallows log errors so removal still runs), then `compose down --volumes --remove-orphans`. If nothing was created (`!this.created`) it writes the no-op `cleanup.log`. Always returns `{summary}`.
- **Abort/cancel:** provisioning methods read `this.signal`; an aborted signal propagates as an abort error from `command(...)`. The runner records remaining checks as `canceled` and still runs cleanup. No special handling needed in the moved code.

### External-input validation rules (unchanged, relocated)

- `repo` (constructor): resolved via `path.resolve`; `revision` defaults `'HEAD'`, validated by git `rev-parse` + hex regex at `snapshot`. Fatal on failure.
- `sourceIdentity` (DAD, runner path only): if present, must match `^github:owner/repo$`; else constructor throws. Optional; discovery never sets it.
- `maxRequests` (runner, not adapter): integer 1–40 else `RunError`. Out of adapter scope; unchanged.
- Actor descriptors (adapter output): `id`/`description`/`entry` required strings; `cookie`/`cookieName` optional. Not defensively validated at runtime today (adapters are trusted first-party); the browser's loopback-origin guard and cookie presence check are the effective enforcement. Keep as-is.

### Invariant ownership

- **Loopback-only origin** — owned by `openDiscoveryBrowser` (re-validates every run) even though adapters construct the origin; the browser is the trust boundary driving a real browser, so it owns enforcement.
- **Run-owned ephemeral database for replay** — owned by the DAD adapter (`discoveryReplayFixture` id/mode/`created` checks), because only the target knows its provisioning identity; the engine cannot judge it.
- **Policy/identifier integrity** — owned by `policy.js` (`validatePolicy` + `hashPolicy`) and the registry; the adapter only supplies the id string.

## 6. Testability

- **Unit (no Docker, no model, no network):** the §2 DAD verifiers and `discoveryFixture`/`discoveryState` are already unit-tested by stubbing `adapter.sql` (`adapter.test.js`, `experiments.test.js`); after relocation the SQL-builder functions in `dad/sql.js` become **independently** unit-testable (assert the exact `BEGIN READ ONLY` / table / no-`token_hash` shape without an adapter instance) — a net testability gain. **Scope note:** these builder tests cover the SQL *string* shape only. The `sql(query)`/`execSql` **exec plumbing** is an argv-shape concern (the `psql -X -v ON_ERROR_STOP=1 …` invocation), NOT a string-shape concern, so it is explicitly covered by the §8.6(b) compose-argv assertion that drives `DadAdapter.sql('SELECT 1')` against a stubbed `command` — not by the builder unit tests. `composeDefinition` stays a pure function testable in isolation. The base `freePort`/`logged`/`compose` helpers are thin wrappers around `command`; `logged`'s evidence-on-failure behavior is unit-testable with a fake `command` + in-memory `run.evidence`.
- **Interface conformance (new, cheap):** add a small test that both `resolveTarget('dad').adapterFactory(...)` and `BenchmarkAdapter` expose the required interface surface — the methods `snapshot/docker/build/database/deploy/discoveryFixture/cleanup` exist and `publicOrigin`/`signal` are assignable — and that `discoveryReplayFixture`/`source` are either absent or of the right kind. This is the concrete proof the formalized interface holds for two different adapters, runnable with no infra.
- **Integration (infra-gated, unchanged):** `test/fixture.postgres.js` (real Postgres via `DadAdapter` + `composeDefinition`) and the `*.browser.js` suites exercise the full Docker/Playwright path. These keep working through the shim re-exports.
- A design that were hard to test here would be one that hid SQL inside private methods; moving SQL into exported builders is deliberately chosen to improve unit testability.

## 7. Engine thread-throughs (keep minimal)

The engine files should see **no** behavioral change. The only import touch is swapping `./targets.js` for `./targets/index.js` in the registry importers (`cli.js`, `discovery-runner.js`, `policy.js`); `runner.js` is left on the `./dad.js` shim and changes nothing (§2/§3). The formalized interface requires **no new parameter** on any engine function: `discoveryFixture()`, `discoveryReplayFixture?`, `publicOrigin`, `source?`, and `signal` are already exactly what the runner reads today. The one thing worth doing (optional, documentation-grade, not behavior): add the JSDoc `@typedef` for `Actor`/`Fixture`/the adapter in `base.js` and reference it from `discovery-runner.js` so the contract is discoverable. No change to `discovery.js`, `discovery-browser.js`, `experiments.js`, `experiment-contract.js`, `application-memory.js`, `source-reader.js`, `core.js`, `model-provider.js`.

## 8. Ordered implementation units

Each unit ends Biome-clean and with the unit suite green (`npm run lint && npm test`, keys unset, no Docker). Build on Move 2's seam; do not redo it.

1. **Create `src/targets/base.js` with the formal interface typedefs + `ProvisioningAdapter` base.** Move `freePort`, `logged`, `compose`, add the new `composeRun(result, label, args, options)` helper (the prepend rule from §3), the generic git-archive skeleton, image build/inspect helper, compose up/down wrappers, the `execSql` plumbing (argv pinned with `-X -v ON_ERROR_STOP=1`, only `service`/`user`/`db` parameterized — §3), `created`/`id`/`signal` bookkeeping, and the generic cleanup flow. No adapter wired yet. *Verify: lint; base helpers unit-test for `logged` evidence-on-failure and for `composeRun` prepending exactly `['compose','-p',id,'-f',file]`.*
2. **Create `src/targets/dad/` (`config.js`, `compose.js`, `sql.js`, `index.js`).** Move `composeDefinition` + nginx template to `compose.js`; move all fixture/verification/projection SQL to `sql.js` as exported builders (byte-identical strings); put required-files/env/db/roles/cookie into `config.js`; make `DadAdapter` extend `ProvisioningAdapter`, binding config into the base helpers, rewriting each inlined `logged(…, ['compose','-p',this.id,'-f',this.file, …])` call to `composeRun(…)` per the §3 rewrite rule (REST copied character-for-character, including the mode-conditional `test-postgres` spread and the templated `-e DONOR_GO_DATABASE_URL=…` element), keeping the exploration-vs-acceptance branching and both summary-string variants verbatim, rewriting `sql(query)` to `execSql({ service: 'postgres', user: 'atm_owner', db: 'dad_atm' }, query)` against the base helper (argv including `-X -v ON_ERROR_STOP=1` preserved element-for-element — §3), and keeping the §2 validation-only methods verbatim. *Verify: lint; `adapter.test.js` + `experiments.test.js` DAD cases pass against `dad/index.js` directly.*
3. **Relocate the benchmark adapter to `src/targets/benchmark.js`** (verbatim; it does not extend the base). *Verify: `benchmark-adapter.test.js` passes against the new path.*
4. **Move the registry to `src/targets/index.js`** (unchanged `targets`/`resolveTarget`/`isRegisteredAdapter`, pointing at the new adapter paths). *Verify: `targets.test.js` passes.*
5. **Update the registry importers** (`discovery-runner.js`, `cli.js`, `policy.js`) from `./targets.js` to `./targets/index.js`; leave `runner.js` on the `./dad.js` shim (unchanged); add the three compatibility shims (`src/targets.js`, `src/dad.js`, `src/benchmark-adapter.js`) as re-exports. *Verify: full `npm test` green with unchanged test imports; `git diff dev...feat/adapter-interface -- src/runner.js` is empty (zero changed lines).*
6. **Add the byte-identical guards + interface-conformance test.** Three new guards plus the conformance test:

   **(a) Policy digest + full-JSON snapshot (`test/targets.test.js`).** Capture the expected values **once from `dev` before any Move 3 commit** so the guard is independent of the refactored code:
   ```sh
   # run on the dev baseline, not on feat/adapter-interface
   node -e "import('./src/discovery-runner.js').then(m=>{const d=m.discoveryPolicy('dad');console.log(d.digest);console.log(JSON.stringify(d.definition))})"
   ```
   Paste both outputs as frozen literal constants in the test. The pinned pre-refactor digest is:
   ```
   be91648ac06f7508faf9148c339d25e0a704f4b7c61c7918b8e7b23892113954
   ```
   and the pinned pre-refactor `JSON.stringify(definition)` body (869 chars) is:
   ```
   {"schemaVersion":1,"id":"impactgraph-discovery","version":"1.3.0","adapter":"impactgraph","scope":"exploration","checks":[{"id":"snapshot","required":true,"timeoutMs":60000,"evidence":["candidate.json"]},{"id":"docker","required":true,"timeoutMs":30000,"evidence":["docker.log","compose-version.log"]},{"id":"build","required":true,"timeoutMs":1800000,"evidence":["build-api.log","build-web.log"]},{"id":"database","required":true,"timeoutMs":180000,"evidence":["migrations.log","test-migrations.log"]},{"id":"deploy","required":true,"timeoutMs":180000,"evidence":["readiness.log"]},{"id":"discovery","required":true,"timeoutMs":660000,"evidence":["discovery.json","discovery-trace.zip"]},{"id":"cleanup","required":true,"timeoutMs":120000,"evidence":["cleanup.log"]}],"findings":{"blockingSeverities":["unassessed","high","critical"]},"exceptions":{"mode":"disabled"}}
   ```
   The test asserts `discoveryPolicy('dad').digest === '<pinned digest>'`, `JSON.stringify(discoveryPolicy('dad').definition) === '<pinned body>'`, and keeps the existing relative `=== discoveryPolicy().digest` check. Comparison uses `JSON.stringify` (the property-insertion order of the in-repo definition object is stable and is itself part of what the snapshot locks); `policy.js`'s `canonical()` serializer is **not** used here because it is module-private (not exported) and the digest assertion already covers canonical-form equality via `hashPolicy`. If either literal mismatches after the refactor, the snapshot has drifted and the move is wrong.

   **(b) Compose-argv snapshot (guards the `composeRun` rewrite AND the `execSql` binding).** Add a unit test that drives a `DadAdapter` with a stubbed `command` (the lowest-level point both `logged`→`command` and `compose`→`command` pass through, so it captures the final argv array regardless of whether the call went via `composeRun` or `compose`; no Docker) and asserts the emitted argv for each byte-identical-sensitive invocation equals the captured pre-refactor argv element-for-element:
   - the `composeRun` phases: `database-start`, `migrations`, `test-migrations` (acceptance mode), `deploy`, and `cleanup`'s `down`;
   - **the `sql`/exec path (closes finding #1's unguarded gap):** drive `DadAdapter.sql('SELECT 1')` with the stubbed `command` and assert the recorded argv equals the pinned literal `['compose','-p',<id>,'-f',<file>,'exec','-T','postgres','psql','-X','-v','ON_ERROR_STOP=1','-U','atm_owner','-d','dad_atm','-At']` — this is the only way a dropped/reordered `-X`/`-v`/`ON_ERROR_STOP=1` flag is caught, since the SQL still parses and verifier counts can still match if `ON_ERROR_STOP` silently goes absent.

   Capture every baseline argv the same way — from `dev`, by stubbing `command` and recording the arrays — and paste them as literal expected arrays. This proves both that the "move the four leading elements into `composeRun`" rewrite and the "parameterize three values in `execSql`" rewrite are identities on the invocation bytes, which the policy-JSON guard (which only covers the compose *definition*) does not cover.

   **(c) Interface-surface conformance test** for both `resolveTarget('dad').adapterFactory(...)` and `BenchmarkAdapter` (methods present, `publicOrigin`/`signal` assignable, `discoveryReplayFixture`/`source` absent-or-right-kind), as the two-adapter proof the formal §1 interface holds.

   *Verify: `npm run lint && npm test` fully green. The pinned digest/JSON/argv literals make the pre-refactor confirmation automatic — the test fails loudly on any drift rather than relying on a manual check.*
7. **Docs touch-up (optional, non-behavioral):** note the `targets/` layout and the formal interface in `README.md`/`docs` if a natural spot exists; do not alter identifier guidance for DAD.

Infra-gated suites (`test:fixture`, `*.browser.js`) are not run in this phase (no Docker/Chromium here) but must remain resolvable via the shims; the orchestrator runs them post-merge.

---

## 9. Responses to design review

### 9.1 First review pass (verdict CHANGES_REQUESTED — 3 MEDIUM, 4 NIT)

All 3 MEDIUM and all 4 NIT findings are addressed in this revision; each change aligns with the original requirement that DAD stays byte-identical and the interface be concrete enough to implement without further architectural decisions. Source facts were re-verified against `src/dad.js`, `src/runner.js`, `src/policy.js`, and `src/discovery-runner.js` in the worktree before editing.

- **#1 MEDIUM (compose wrappers under-specified vs inlined call sites) — ADDRESSED.** §3 now defines a concrete base helper `composeRun(result, label, args, options)` that prepends **exactly** `['compose','-p',this.id,'-f',this.file]` and appends `args` verbatim, with a binding rewrite rule (each inlined `logged(…, ['compose','-p',this.id,'-f',this.file, ...REST], OPTS)` → `composeRun(…, [...REST], OPTS)`, `REST` copied character-for-character) and the invariant that the flattened argv must equal the pre-refactor array element-for-element. Call sites are cited by unique label string (with current-worktree line numbers): `database-start` (:299), `migrations` (:315), `test-migrations` (:327), `suite`/`name` (`async suite`, :358), `deploy` (:373), cleanup `down` (:588). §8.6(b) adds a compose-argv snapshot guard asserting the emitted argv for `database-start`, `migrations`, `test-migrations`, `deploy`, and `cleanup` equals captured pre-refactor literals.
- **#2 MEDIUM (0-vs-1-line `runner.js` contradiction) — ADDRESSED, resolved to zero lines.** Adopted the reviewer's recommended end state: `runner.js` keeps `import { DadAdapter } from './dad.js'` (confirmed at `runner.js:4`) and the `src/dad.js` shim re-exports the relocated class, so the file changes **zero** lines. §3 now excludes `runner.js` from the path updates (only `discovery-runner.js`/`cli.js`/`policy.js` move to `./targets/index.js`); both §4 rows and §7 and §8.5 now say "zero changed lines / empty diff."
- **#3 MEDIUM (policy-JSON snapshot guard had no capture spec) — ADDRESSED.** §4 and §8.6(a) now specify capturing the digest and `JSON.stringify(definition)` **once from `dev` before any Move 3 edit** (exact `node -e …` command given) and pasting them as frozen literals, making the guard independent of the refactored code. The exact pre-refactor digest (`be91648a…13954`) and the full 869-char JSON body are pinned verbatim in §8.6. **Single source of truth: the `dev` baseline.** The worktree is byte-equal to `dev` for the policy module because this move changes no policy bytes (`policy.js`/`discovery-runner.js`/the registry values are untouched), so capturing on `dev` or on the current worktree yields the identical literal — but the design standardizes on "capture on `dev`" to keep the guard provably independent of any Move 3 edit. Noted that `policy.js`'s `canonical()` is module-private, so the full-body guard uses `JSON.stringify` while the digest assertion covers canonical equality; the manual confirmation step is replaced by the failing-literal assertion.
- **#4 NIT (factory options "exactly {repo,revision,signal}") — ADDRESSED.** §1 item 1 reworded: discovery passes exactly the three options properties `{ repo, revision, signal }`; the acceptance runner additionally sets an `sourceIdentity` **property on the same single options object** (`runner.js:47` — not a positional 4th argument), which DAD validates and discovery leaves `undefined`; `sourceIdentity` is a DAD-only extra property, not part of the formal contract.
- **#5 NIT (mode-conditional `*-checks`/`test-postgres` artifacts omitted) — ADDRESSED.** The DAD-specific section of §3 now has an explicit note that the `mode !== 'exploration'` branching (`*-checks` image builds `dad.js:264-272`, `test-postgres` spread `dad.js:311` + `test-migrations` `dad.js:326-349`, vs the "Not applicable" `test-migrations.log` and the two mode-dependent summary strings) moves verbatim into `dad/index.js` and is **not** absorbed by the base helper; the image-build bullet cross-references it.
- **#6 NIT (benchmark cookieName presented as load-bearing) — ADDRESSED.** The actor-descriptor prose in §1 now states benchmark auth keys on the cookie *value* substring (`test-a`/`test-b`) regardless of name, so `cookieName: 'session'` is cosmetic and only exercises Move 2's `cookieName ?? …` seam; DAD's `dad_donor_session` is contrasted as functionally required.
- **#7 NIT (shim/import graph not shown acyclic) — ADDRESSED.** §3 now walks the full downward-only import graph (shims → `targets/index.js` → `targets/dad/index.js`/`benchmark.js` → leaves), states the enforcement rule that no `src/targets/*` module may import a shim, and concludes the graph is a DAG with no circular-re-export `undefined`-export hazard.

No findings were backlogged or ignored; the fixes stay within the original scope (pure reorganization + formal-interface documentation with a byte-identical DAD target) and introduce no new requirements.

### 9.2 Second review pass (verdict CHANGES_REQUESTED — 1 MEDIUM, 4 NIT)

This pass reviewed the revised doc fresh. All findings are resolved; each change was re-verified against `src/dad.js` in the worktree (argv at `:291-295`, `:299`, `:311`, `:315`, `:326-349`, `:358`, `:373`, `:588`, `*-checks` at `:264-272`) before editing. No finding was backlogged or ignored — all stay within the byte-identical / concrete-interface requirements.

- **#1 MEDIUM (`execSql` under-specified; no guard covers the `sql`/exec argv) — ADDRESSED.** §3's `execSql` bullet now pins the argv element-for-element to the real DAD invocation `['exec','-T','postgres','psql','-X','-v','ON_ERROR_STOP=1','-U','atm_owner','-d','dad_atm','-At']` (`dad.js:291-295`), parameterizing **only** `service`/`user`/`db`, with the full helper body inlined and a binding element-for-element invariant; it explicitly calls out `-X -v ON_ERROR_STOP=1` as load-bearing (never to be dropped/reordered). §8.6(b) is extended to drive `DadAdapter.sql('SELECT 1')` against a stubbed `command` and assert the recorded argv equals a pinned literal — closing the previously-unguarded `compose(...)` (non-`composeRun`) exec path. A dedicated row in the §4 invariant table records this proof.
- **#2 NIT (`src/dad.js` line numbers off by a few) — ADDRESSED.** All cited line numbers in §3 (`composeRun` bullet, mode-conditional note) and §9.1 #1/#5 corrected to the current worktree (`database-start` :299, `migrations` :315, `test-migrations` :327, `suite` :358, `deploy` :373, `down` :588, `*-checks` :264-272, `test-postgres` spread :311, `test-migrations` migrate block :326-349), and the label strings are now stated as the authoritative locators since they are unique and greppable if lines drift.
- **#3 NIT (digest capture source described two ways) — ADDRESSED.** §4/§8.6(a) and §9.1 #3 now state a single source of truth — the `dev` baseline — and note the worktree is byte-equal to `dev` for the policy module because this move changes no policy bytes, so either capture yields the identical literal.
- **#4 NIT (`4th field` phrasing for `sourceIdentity`) — ADDRESSED.** §1 item 1, the §4 `runner.js` row, and §9.1 #4 reworded to "an additional `sourceIdentity` property on the same single options object" (not a positional 4th argument), matching `runner.js:47`.
- **#5 NIT (`sql` exec-path testability claim overstated) — ADDRESSED.** §6's first testability bullet now scopes the builder unit tests to the SQL *string* shape only and defers the `sql`/`execSql` exec-plumbing (argv-shape) coverage to the §8.6(b) argv assertion added under finding #1.

---

Design doc path: `/Users/shawncoe/Documents/dev/DAD/atm/.worktrees/move3-adapter-split/.agents/tasks/move3-adapter-interface-design.md`
