# Implementation Plan — Move 2: Generalize the ATM self-discovery harness to generic targets

All paths are absolute inside the worktree
`/Users/shawncoe/Documents/dev/DAD/atm/.worktrees/move2-generic-targets`. The coder's cwd is the
parent workspace, so always use absolute paths and `git -C <worktree>`.

## Design decisions resolved against the existing code

These were decided by reading the live source; the coder must not re-litigate them.

### Adapter interface (resolved from `src/discovery-runner.js` + `src/dad.js` + `scripts/benchmark-discovery.js`)

`executeDiscovery` (discovery-runner.js) drives an adapter object via exactly these members, in order:

- Settable property `adapter.signal` — reassigned before every step.
- Provisioning methods `snapshot(result)`, `docker(result)`, `build(result)`, `database(result)`,
  `deploy(result)` — each called inside `run.step(id, ...)`; each returns `{ summary }` and pushes
  evidence onto `result.evidence`.
- `adapter.publicOrigin` — a string loopback origin (`http://127.0.0.1:PORT/` or
  `http://localhost:PORT`). `openDiscoveryBrowser` requires http, hostname `localhost`/`127.0.0.1`,
  a port, and pathname `/`.
- `adapter.discoveryFixture()` — async, returns an array of actor descriptors
  `{ id, description, entry?, cookie? }`. Actor[0] is the guest/default.
- `adapter.source` — optional path to a source tree (fed to `sourceReader`); may be `undefined`.
- `adapter.discoveryReplayFixture()` — optional; returns a `replayFixture(...)` object
  (`{ inspect?, replay? }`) or `undefined`. `discovery-browser.js` already degrades gracefully when
  `fixture.replay`/`fixture.inspect` are absent (observed-only, read-only replay).
- `cleanup(result)` — always called in `finally`; returns `{ summary }`.

Optional members the benchmark adapter may add (DAD already has them): `source` getter. No other
adapter members are called by the runner.

### Registry shape (`src/targets.js`, new)

A single module is the one place CLI/runner resolve a target name to an adapter factory and its
policy identity. Resolved shape:

```js
// src/targets.js
export const targets = {
  dad: {
    adapterFactory: (run, options) => new DadAdapter(run, options),
    policyId: 'impactgraph-discovery', // byte-identical to today
    adapterId: 'impactgraph',          // byte-identical to today
  },
  benchmark: {
    adapterFactory: (run, options) => new BenchmarkAdapter(run, options),
    policyId: 'benchmark-discovery',
    adapterId: 'benchmark',
  },
};
export function resolveTarget(name = 'dad') {
  const target = targets[name];
  if (!target) throw new Error(`Unknown target: ${name}. Known targets: ${Object.keys(targets).join(', ')}.`);
  return target;
}
export const isRegisteredAdapter = id => Object.values(targets).some(t => t.adapterId === id);
```

Rationale: a plain object keyed by target name is the smallest thing that satisfies "single place to
resolve." `policyId`/`adapterId` live beside the factory so the runner parameterizes the policy from
one lookup. `isRegisteredAdapter` lets policy.js accept any registered adapter id without importing
the whole runner.

### Cookie-name threading (resolved)

The cookie NAME becomes a per-actor field `cookieName` on the actor descriptor returned by
`discoveryFixture()`. `openDiscoveryBrowser`'s `bootstrap(context, who)` uses
`who.cookieName ?? 'dad_donor_session'` as the cookie name. This keeps the default behavior
byte-identical for DAD (DAD actors will carry `cookieName: 'dad_donor_session'` explicitly, and the
`?? 'dad_donor_session'` fallback covers any actor that omits it). The benchmark authenticates by
cookie VALUE substring (`test-a`/`test-b`), so its actors carry `cookie: 'test-a'`/`'test-b'` and any
`cookieName` works; the benchmark adapter will set `cookieName: 'session'` for clarity.

Rationale for per-actor over per-adapter: `openDiscoveryBrowser` only ever sees `actors`, not the
adapter. Threading through the actor descriptor avoids adding a new parameter to the browser factory
and keeps the change to one line in `bootstrap` plus the fixture producers.

### Per-target policy identity (resolved, DAD byte-identical)

`discoveryPolicy()` in discovery-runner.js becomes `discoveryPolicy(target = 'dad')`. It looks up
`resolveTarget(target)` and substitutes `definition.id = policyId` and `definition.adapter =
adapterId`. For `target === 'dad'` these are `'impactgraph-discovery'` and `'impactgraph'` — exactly
today's literals, so the canonical hash/digest is unchanged. `executeDiscovery` also passes the
resolved `adapterId` to `Run.create(..., { adapter: adapterId, ... })` (today hard-coded
`'impactgraph'`); for `dad` this stays `'impactgraph'`. Non-dad targets get namespaced ids
(`benchmark-discovery` / `benchmark`).

policy.js:43 stops requiring `adapter === 'impactgraph'` and instead requires a non-empty
registered adapter id: `!isRegisteredAdapter(policy.adapter)`. All other validation (schema fields,
evidence contracts, scenario versions, digest, blocking severities, exceptions) is unchanged.

### Scope boundaries

- The `run` (deterministic acceptance) pipeline in `src/runner.js` and the file-based `loadPolicy`
  path stay DAD-only and unchanged: the default policy file `policies/impactgraph-local.json` keeps
  `adapter: 'impactgraph'`, which remains a registered id, so `validatePolicy` still accepts it. No
  `--target` on `run`.
- `--target` is added only to the CLI and wired only into `explore`/`executeDiscovery`.
- Do NOT touch `scenarios.js`, `agent.js`, deterministic `browser.js` journeys. The benchmark's
  simple public journey / live model call is out of scope.

## Files created or modified

- **new** `src/targets.js` — adapter registry + `resolveTarget` + `isRegisteredAdapter`.
- **new** `src/benchmark-adapter.js` — `BenchmarkAdapter` wrapping `benchmarkApplication()`.
- `src/discovery-browser.js` — parameterize cookie name in `bootstrap`.
- `src/dad.js` — `discoveryFixture()` actors carry `cookieName: 'dad_donor_session'`.
- `src/policy.js` — relax adapter lock to accept any registered adapter id.
- `src/discovery-runner.js` — `discoveryPolicy(target)`, resolve adapterFactory/adapterId from
  registry, thread `target` through `executeDiscovery`.
- `src/cli.js` — add `--target` option (default `dad`), validate, pass to `executeDiscovery`.
- **new tests** `test/targets.test.js`, `test/benchmark-adapter.test.js`; **update**
  `test/policy.test.js` and any test asserting the old cookie/adapter lock (none assert the literal
  cookie today; `policy.test.js` exercises the adapter lock indirectly).

## Ordered steps

- [ ] 1. Add the adapter registry module `src/targets.js`.
      Export `targets` (object keyed by `dad`, `benchmark`), `resolveTarget(name='dad')`,
      `isRegisteredAdapter(id)`. Import `DadAdapter` from `./dad.js`. The `benchmark` entry's
      `adapterFactory` imports `BenchmarkAdapter` from `./benchmark-adapter.js` (created in step 5);
      to avoid a forward-reference ordering problem, use a lazy dynamic import inside the factory OR
      land step 5 in the same change — prefer landing `src/benchmark-adapter.js` first with a
      minimal skeleton, then this registry. Keep `dad.policyId='impactgraph-discovery'`,
      `dad.adapterId='impactgraph'`, `benchmark.policyId='benchmark-discovery'`,
      `benchmark.adapterId='benchmark'`. ESM, Biome-clean.
      Files: src/targets.js (and a minimal src/benchmark-adapter.js if needed to satisfy the import)
      Verify: `cd <worktree> && npm run lint` is clean.

- [ ] 2. Parameterize the discovery auth-cookie name in `src/discovery-browser.js`.
      In `bootstrap(context, who)` change the hard-coded `name: 'dad_donor_session'` to
      `name: who.cookieName ?? 'dad_donor_session'`. No other change.
      Files: src/discovery-browser.js
      Verify: `cd <worktree> && npm run lint && npm test` — all existing tests pass (behavior
      unchanged because the fallback preserves `dad_donor_session`).

- [ ] 3. Make `src/dad.js` supply the cookie name through the new path.
      In `discoveryFixture()`, add `cookieName: 'dad_donor_session'` to each authenticated donor
      actor descriptor (the two `donor-a`/`donor-b` entries). Guest actor (no cookie) is unaffected.
      Files: src/dad.js
      Verify: `cd <worktree> && npm test` — existing adapter/discovery tests pass.

- [ ] 4. Relax the policy adapter lock in `src/policy.js`.
      Import `isRegisteredAdapter` from `./targets.js`. Replace the `policy.adapter !== 'impactgraph'`
      clause in `validatePolicy` with `!isRegisteredAdapter(policy.adapter)` (equivalently reject any
      adapter not registered). Leave every other check (schemaVersion, id regex, version regex,
      scope, evidence contracts, scenario versions, digest, blocking severities, exceptions) exactly
      as-is. Confirm the default file `policies/impactgraph-local.json` (adapter `impactgraph`) still
      validates.
      Files: src/policy.js
      Verify: `cd <worktree> && npm test` — `test/policy.test.js` still passes; the default policy
      loads.

- [ ] 5. Add `BenchmarkAdapter` in `src/benchmark-adapter.js` satisfying the runner's adapter
      contract over `benchmarkApplication()`.
      Constructor `(run, { signal })`. Provisioning methods `snapshot/docker/build/database/deploy`
      are lightweight: `snapshot(result)` instantiates `benchmarkApplication('healthy')`, stores the
      returned `{ origin, actors, fixture, close }`, writes `candidate.json` evidence
      (`run.data.candidate = { revision: digest(benchmarkSource+benchmarkContract).slice(0,40),
      source: 'benchmark:synthetic-profile' }`), and sets `this.publicOrigin = origin`; the remaining
      provisioning methods are no-ops that still push their required evidence log files (see
      `evidenceRequirements` keys: docker→`docker.log`,`compose-version.log`; build→`build-api.log`,
      `build-web.log`; database→`migrations.log`,`test-migrations.log`; deploy→`readiness.log`) with
      "Not applicable: in-process benchmark" content so policy evidence contracts are satisfied.
      `discoveryFixture()` returns the benchmark's actors with `cookieName: 'session'` added to the
      cookie-bearing donors (`cookie` stays `test-a`/`test-b`). `source` getter returns a source path
      written under `run.dir/source` from `benchmarkSource`/`benchmarkContract` (mirror
      scripts/benchmark-discovery.js). `discoveryReplayFixture()` returns the app's `fixture`.
      `cleanup(result)` calls the stored `close()` and writes `cleanup.log`.
      Files: src/benchmark-adapter.js
      Verify: `cd <worktree> && npm run lint` clean; covered by step 8 tests.

- [ ] 6. Parameterize the policy identity by target in `src/discovery-runner.js`.
      Change `discoveryPolicy()` to `discoveryPolicy(target = 'dad')`; resolve
      `const { policyId, adapterId } = resolveTarget(target)` and set `definition.id = policyId`,
      `definition.adapter = adapterId`. In `executeDiscovery`, accept a new `target = 'dad'` option;
      resolve `const resolved = resolveTarget(target)`; default `adapterFactory` to
      `resolved.adapterFactory`; call `discoveryPolicy(target)`; pass `adapter: resolved.adapterId`
      to `Run.create` instead of the literal `'impactgraph'`. Import `resolveTarget` from
      `./targets.js`. For `target==='dad'` every emitted value is byte-identical to today.
      Files: src/discovery-runner.js
      Verify: `cd <worktree> && npm test` — `test/discovery.test.js` passes unchanged (its
      `discoveryPolicy()` call still yields `impactgraph-discovery`).

- [ ] 7. Add the `--target` flag to `src/cli.js` and wire it into `explore`.
      Add `target: { type: 'string', default: 'dad' }` to `parseArgs` options. Validate it against
      the registry (`resolveTarget(values.target)` throws on unknown). Reject `--target` on `run`
      (only `explore` supports it) OR allow it but require `dad` for `run`; prefer: error if
      `!discovery && values.target && values.target !== 'dad'`. For `explore`, when `target !== 'dad'`
      a `--repo` must NOT be required (benchmark provisions in-process); relax the `!values.repo`
      guard so `explore --target benchmark` works without `--repo`. Pass `target: values.target` into
      the `executeDiscovery` call. Add a `--target` line to the `help` text.
      Files: src/cli.js
      Verify: `cd <worktree> && npm test` — existing CLI/policy tests pass; manual
      `node src/cli.js explore --target benchmark --max-requests 1` reaches provisioning without
      Docker/model (see step 9 smoke).

- [ ] 8. Add focused unit tests.
      `test/targets.test.js`: `resolveTarget('dad')` and `resolveTarget('benchmark')` return factories
      and the expected `policyId`/`adapterId`; `resolveTarget('nope')` throws;
      `isRegisteredAdapter('impactgraph')` true, `isRegisteredAdapter('benchmark')` true,
      `isRegisteredAdapter('bogus')` false. Also assert `discoveryPolicy('dad').definition.id ===
      'impactgraph-discovery'` and `.adapter === 'impactgraph'`, and that
      `discoveryPolicy('dad').digest === discoveryPolicy().digest` (proves DAD byte-identical);
      assert `discoveryPolicy('benchmark').definition.id === 'benchmark-discovery'`.
      Extend `test/policy.test.js`: add a case that a policy with `adapter: 'benchmark'` (otherwise
      valid exploration policy, e.g. clone `discoveryPolicy('benchmark').definition`) passes
      `validatePolicy`, while `adapter: 'unregistered'` throws — keeping the existing malformed-policy
      cases intact.
      `test/benchmark-adapter.test.js`: construct `BenchmarkAdapter`, run `snapshot` + `deploy`
      (or whichever sets origin), assert `publicOrigin` parses as a loopback http origin and is
      reachable (fetch returns a response), assert `discoveryFixture()` yields the guest + two donor
      actors and that donor actors carry `cookie` `test-a`/`test-b` plus a `cookieName`; call
      `cleanup` and assert the server closes. NO model call.
      Also add a DAD-cookie assertion: in `test/adapter.test.js` (or targets test), assert that a DAD
      `discoveryFixture()` actor carries `cookieName: 'dad_donor_session'`; and a browser-layer
      assertion that `bootstrap` defaults to `dad_donor_session` when `cookieName` is absent — if a
      direct unit is awkward, assert the default via a small helper or document it is covered by the
      existing discovery browser test behavior.
      Files: test/targets.test.js, test/benchmark-adapter.test.js, test/policy.test.js,
      test/adapter.test.js
      Verify: `cd <worktree> && npm test` — all tests (existing + new) pass.

- [ ] 9. Prove the benchmark smoke path works without Docker or a model key.
      Confirm `node --test test/benchmark-adapter.test.js` runs with no `OPENAI_API_KEY`/`ATM_MODEL`
      set and no Docker, provisioning the in-process app and yielding a reachable `publicOrigin`.
      Do NOT attempt a live model call. (The existing `npm run benchmark:discovery` non-live path is
      the model-driven benchmark and stays as-is; this smoke only proves adapter wiring.)
      Files: (none — verification only)
      Verify: `cd <worktree> && node --test test/benchmark-adapter.test.js` passes with no API key
      and Docker stopped.

## Final verification commands (the implementer must run all)

```sh
cd /Users/shawncoe/Documents/dev/DAD/atm/.worktrees/move2-generic-targets
npm run lint        # Biome --error-on-warnings, must be clean
npm test            # node --test test/*.test.js — all unit tests pass (existing + new)
node --test test/benchmark-adapter.test.js   # benchmark smoke, no Docker, no model key
```

Proof that `dad` is unchanged: `test/targets.test.js` asserts
`discoveryPolicy('dad').definition.id === 'impactgraph-discovery'`,
`.adapter === 'impactgraph'`, and `discoveryPolicy('dad').digest === discoveryPolicy().digest`.
Docker/Postgres fixture tests (`npm run test:fixture`, `npm run test:browser`) are NOT required for
this change and are not part of the smoke path.

## Known gaps / assumptions

- The benchmark adapter runs observed-only (no DB inspect against DAD's schema); this is acceptable
  per the brief because `discovery-browser.js` degrades gracefully without replay/inspect, and the
  benchmark's own `fixture` (from `benchmarkApplication`) does supply inspect/replay if wired through
  `discoveryReplayFixture()`.
- `run` stays DAD-only by design; generalizing deterministic acceptance to other targets is out of
  scope for Move 2.
