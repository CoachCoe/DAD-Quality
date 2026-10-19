# Design review — Move 3 adapter split (`move3-adapter-interface-design.md`)

Reviewed fresh, without the context that produced the design. Grounding files spot-read in the worktree: `src/dad.js`, `src/discovery-runner.js`, `src/targets.js`, `src/benchmark-adapter.js`, plus `src/policy.js`, `src/runner.js`, `src/discovery-browser.js`, `src/discovery-benchmark.js`. No builds or test suites were run. Where the design pins a literal (digest, policy JSON, argv), I recomputed or re-read the source to confirm it.

This is the third review pass (the doc carries §9.1 and §9.2 responses to two prior passes). The byte-identical foundation is strong and independently verified. The remaining issues are a proof-coverage gap and some smaller precision gaps.

## Verdict basis

Findings below: 1 MEDIUM, 0 HIGH, 4 NIT. HIGH+MEDIUM count is 1 (> 0), so the verdict is **CHANGES_REQUESTED**.

## Findings

### 1. MEDIUM — `suite` is in the `composeRun` rewrite set but omitted from the §8.6(b) argv guard

**Where:** §3 `composeRun` bullet (lists `suite`'s `name` at `dad.js:358` among the inlined call sites to rewrite) vs §8.6(b) and the §4 invariant table.

**Problem:** §3 commits to rewriting `suite(result, name)`'s inlined `this.logged(result, name, 'docker', ['compose','-p',this.id,'-f',this.file,'run','--rm','-T',name], …)` (confirmed at `src/dad.js:358-361`) into `composeRun`. That is a behavioral-source argv rewrite of a byte-identical-sensitive acceptance-pipeline method. But the §8.6(b) compose-argv snapshot guard enumerates only `database-start`, `migrations`, `test-migrations` (acceptance mode), `deploy`, and `cleanup`'s `down`. `suite` is not in that list, and §9.1 #1 / §9.2 confirm the guard set never included it. So one of the rewritten argv call sites has no byte-identical proof. The `suite` services (`api-tests`/`web-tests`) only run in the infra-gated acceptance path, which §8 explicitly does *not* run in this phase, so a silent argv regression there would pass the whole unit suite undetected — exactly the failure mode the argv guard exists to prevent.

**Fix:** Add `suite` to the §8.6(b) argv guard. Concretely, drive both `DadAdapter.suite(result, 'api-tests')` and `suite(result, 'web-tests')` against the stubbed `command` and assert each recorded argv equals the pinned pre-refactor literal:
```js
['compose','-p',<id>,'-f',<file>,'run','--rm','-T','api-tests']
['compose','-p',<id>,'-f',<file>,'run','--rm','-T','web-tests']
```
Capture both from `dev` the same way as the other baseline argvs. Update the §4 table row and §8.6(b) enumeration to include `suite`, so every method the §3 rewrite rule touches has a matching guard.

### 2. NIT — `deploy`'s second compose call (health-exec) is asserted "pure relocation" but not listed among the `compose(...)` sites and not guarded

**Where:** §3 ("All existing `this.compose([...])` call sites ... are a pure relocation") and §8.6(b) (which guards only the `sql`/exec `compose` path).

**Problem:** `deploy()` contains a second compose invocation beyond the `composeRun`-rewritten `'deploy'` log: the readiness probe `this.compose(['exec','-T','web','node','-e', …])` (`src/dad.js:380-388`). It stays a `this.compose(...)` call (no rewrite), so it is lower risk than the argv rewrites — but §3's blanket "all `compose(...)` sites are a pure relocation" glosses over the fact that `compose`'s body is itself moving into the base class. Since the only `compose`-path argv the guard covers is `sql`/exec, a regression in `compose`'s prepend (`['compose','-p',this.id,'-f',this.file, …]`) would be caught there, so this is not a coverage hole — but the design should say so explicitly rather than leave the deploy health-exec unmentioned.

**Fix:** Add one sentence to §3 (or §8.6(b)): "`deploy`'s readiness health-exec and the `discoveryReplayFixture` stop/start/pg_dump calls remain `this.compose(...)` (pure relocation, no argv rewrite); `compose`'s prepend correctness is proven transitively by the `sql`/exec argv guard, which exercises the same `compose` method." No new guard required.

### 3. NIT — `freePort` call-site transformation is unguarded and not called out as a source edit

**Where:** §3 "Generic machinery to extract" — `freePort()` "module-level helper in `dad.js` today; move to `base.js`, export for reuse."

**Problem:** `freePort` is currently a module-scope function called bare as `freePort()` inside `docker()` (`src/dad.js:201`). Moving it to `base.js` and exporting it changes the DAD call site from a bare call to an imported symbol (or a `this.freePort()` method call). That is a source edit to a byte-identical-sensitive file. It is genuinely low-risk because the function's output is a random free port (non-deterministic, so it can never be byte-pinned anyway) and the behavior is identical, but the design lists it without flagging it as a call-site edit the way it carefully flags the `composeRun`/`execSql` rewrites.

**Fix:** State the chosen form (free export `import { freePort } from '../base.js'` and bare `freePort()`, or a `this.freePort()` base method) and note it is a mechanical symbol-resolution change with no behavioral effect (output is a random port, not snapshot-testable). Pick one to remove ambiguity.

### 4. NIT — `*-checks` line range cited as `264-272` but the block is `267-270`

**Where:** §3 mode-conditional note and §9.1 #5 / §9.2 #2 (`*-checks` image builds `dad.js:264-272`).

**Problem:** The `build-${service}-checks` `this.logged(...)` call occupies `src/dad.js:266-272` (the `if (mode !== 'exploration')` guard is at `:265`, the `logged` call body `:266-272`). The cited `264-272` starts two lines early. All other line numbers in the doc verified exact (`:291-295`, `:299`, `:311`, `:315`, `:327`, `:358`, `:373`, `:588`). The design already states label strings are the authoritative locators, so this does not block implementation.

**Fix:** Change `264-272` to `266-272` (or `265-272` to include the guard) in both §3 and the §9 responses, or drop the line range and rely on the `build-${service}-checks` label string as stated.

### 5. NIT — §1 does not say the `discovery`-phase evidence (`discovery.json`, `discovery-trace.zip`) is runner-produced, which could read as an adapter gap

**Where:** §1 "Required methods" evidence sentence lists only `snapshot`→`candidate.json` … `cleanup`→`cleanup.log`, omitting the `discovery` row of `evidenceRequirements`.

**Problem:** `policy.js` `evidenceRequirements` (confirmed `src/policy.js:9-23`) includes `discovery: ['discovery.json','discovery-trace.zip']`, and the policy's `checks` array includes a `discovery` check (confirmed in the pinned 869-char JSON). The §1 evidence list correctly omits it because the *runner* writes `evidence/discovery.json` and the browser produces the trace — the adapter is not responsible for discovery-phase evidence. But §1 never states this, so a third-party implementer reading "must emit the evidence filenames the policy mandates for that phase" could wrongly conclude the adapter must emit `discovery.json`/`discovery-trace.zip` too.

**Fix:** Add one clause to §1: "The `discovery` and (acceptance-only) journey checks' evidence are produced by the runner/engine, not the adapter; the adapter is responsible only for the five provisioning phases' evidence plus `cleanup.log`."

## Verified assumptions

These design claims were checked against source and are accurate:

- **Formal interface matches `executeDiscovery`.** The runner calls `adapter.snapshot/docker/build/database/deploy` in that exact order (loop at `discovery-runner.js`), then `discoveryFixture()`, optional `discoveryReplayFixture` (guarded by `adapter.discoveryReplayFixture ? … : undefined`), optional `adapter.source` (reader called only when set), `adapter.publicOrigin`, writable `adapter.signal`, and always `adapter.cleanup(result)` in `finally`. All of this is present in §1. ✔
- **Signal discipline.** Runner sets `adapter.signal = AbortSignal.any([signal, deadline])` per phase and `AbortSignal.timeout(deadline)` alone for `cleanup`; discovery additionally composes `AbortSignal.any([adapter.signal, AbortSignal.timeout(discoveryLimits.durationMs)])`. Matches §1. ✔
- **Actor descriptor shape and cookie seam.** `discovery-browser.js:107` uses `who.cookieName ?? 'dad_donor_session'`; runner projects `{id,description,entry}` into the report. DAD's authenticated donors carry `cookieName:'dad_donor_session'` (`dad.js` `discoveryFixture`), benchmark adds `cookieName:'session'` in its `discoveryFixture`. §1 matches. ✔
- **Benchmark auth is cookie-value substring, so its `cookieName` is cosmetic.** `discovery-benchmark.js:32-34` matches `request.headers.cookie?.includes('test-a'|'test-b')`; source actors carry `cookie:'test-a'/'test-b'` with no name. §1's contrast with DAD's name-matched cookie is correct. ✔
- **`publicOrigin` loopback guard.** `discovery-browser.js` throws `'Discovery requires a run-owned loopback origin.'` unless `http:`, host `localhost`/`127.0.0.1`, explicit port, pathname `/`, no username/password. Exactly as §1/§5 describe. DAD sets origin in `docker()`, benchmark (`http://127.0.0.1:${port}`) in `snapshot()`. ✔
- **§2 validation-only methods stay with DAD.** `invitation/verifyStaff/donorFixture/verifyDonor/performanceFixture/suite/discoveryState/sql` are all DAD-only; the runner never calls them (verified — none appear in `discovery-runner.js`). `discoveryState` is wired only as the `inspect` callback inside DAD's `discoveryReplayFixture` (`dad.js`). Correctly excluded from the formal contract. ✔
- **Policy digest + JSON pin.** Recomputed on the worktree: `discoveryPolicy('dad').digest === be91648ac06f7508faf9148c339d25e0a704f4b7c61c7918b8e7b23892113954`, and `JSON.stringify(definition)` is exactly the 869-char body pinned in §8.6(a), byte-for-byte. The byte-identical proof's anchors are real. ✔
- **`canonical()` is module-private; `hashPolicy` is exported.** `policy.js` defines `canonical` without `export`; `hashPolicy` is exported. §8.6(a)'s justification for using `JSON.stringify` rather than `canonical` is valid. ✔
- **`runner.js` byte-identical premise.** `runner.js:4` imports `{ DadAdapter } from './dad.js'`; `:47` constructs `new DadAdapter(run, { repo, revision, sourceIdentity, signal })` (options object, not positional 4th arg); `:26` has the `scope !== 'local-acceptance'` guard; `:35` passes literal `adapter:'impactgraph'`. The shim-at-`src/dad.js` plan leaves this file at zero changed lines, as claimed. ✔
- **`sql`/exec argv.** `dad.js:291-295` is exactly `['exec','-T','postgres','psql','-X','-v','ON_ERROR_STOP=1','-U','atm_owner','-d','dad_atm','-At']` with `{ input: query }`. The §3 `execSql` pin and the `-X -v ON_ERROR_STOP=1` load-bearing note are correct. ✔
- **Inlined compose call sites + labels.** `database-start` (:299), `migrations` (:315), `test-migrations` (:327), `deploy` (:373), `cleanup` `down` (:588), and the mode-conditional `test-postgres` spread (:311) all verified at the cited lines with the cited label strings. ✔
- **Evidence requirements.** `policy.js:9-23` matches the per-phase filename contract in §1 (`candidate.json`, `docker.log`/`compose-version.log`, `build-api.log`/`build-web.log`, `migrations.log`/`test-migrations.log`, `readiness.log`, `cleanup.log`). ✔
- **Inheritance/composition split.** Benchmark adapter (`benchmark-adapter.js`) is a standalone class with no Docker/git machinery; the design's "base is a convenience for provisioning targets, benchmark does not extend it" is consistent with the source. ✔
- **Replay-fixture gating.** DAD `discoveryReplayFixture` throws `'Fixture replay requires a run-owned exploration database.'` unless `mode==='exploration' && this.created && /^atm-[0-9]{14}-[a-f0-9]{8}$/.test(this.id)`. Matches §5. ✔

## Unverified / wrong assumptions

- **`suite` argv proof — gap (Finding 1).** The design asserts the §3 rewrite rule is "provably an identity on the emitted argv" for every rewritten call, but the mechanized proof (§8.6(b) argv guard) does not actually exercise `suite`. So for `suite` specifically the identity claim rests on manual inspection, not the automated guard the design relies on everywhere else. Not wrong, but unproven by the stated method.
- **`*-checks` line range (Finding 4).** Cited `264-272`; actual `logged` call body is `266-272`. Minor off-by-two; the label string locator is correct.
- **107+ unit tests pass with keys unset / no Docker (§4, §8).** Not verified — no test run was performed per instructions. Stated as a design expectation; the shim and import-graph reasoning supporting it (downward-only DAG, no module imports a shim) is sound on inspection, but the green-suite claim itself is unconfirmed here.
- **`git diff dev...feat/adapter-interface -- src/runner.js` is empty.** Not verified against the actual `dev` baseline (no git diff run). The premise that the shim keeps `runner.js` unedited is sound given `runner.js:4` imports `./dad.js`, but the empty-diff assertion is a claim about a diff not executed in this review.
