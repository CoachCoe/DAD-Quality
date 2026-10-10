# ATM — application quality runner

ATM is a local quality workspace for ImpactGraph. Launch isolated acceptance runs, compare candidates, inspect evidence, and triage recurring failures through a browser dashboard or CLI.

## Open the workspace

```sh
npm ci
npm exec playwright install chromium
npm start -- --repo /Users/shawncoe/Documents/dev/ImpactGraph
```

Open **http://127.0.0.1:4310** using the exact URL printed by the server. Existing runs under `.atm/runs/` appear automatically. Use `--port` and `--output` to change the listening port or history directory.

- **Overview:** latest candidate, actual run totals, findings awaiting triage, and automation settings.
- **Validation runs:** filter by status or search commit/run IDs; expand checks to open logs, screenshots and downloadable traces. Inspect changes from the previous completed candidate and verify evidence hashes.
- **Findings:** repeated failed checks are grouped by application, check and normalized error signature. Set severity, confirm, dismiss or resolve, and retain an assessment history. Download a finding with its pinned reproduction command.
- **Run validation:** select a local commit, branch or tag. ATM resolves it to a SHA before execution, permits one active dashboard run, and supports cancellation with cleanup.
- **Commit watch:** opt in to validate new local commits every 15 seconds while the dashboard is running. Enabling establishes a baseline; it does not run the existing commit or fetch remote changes. If commits accumulate during a run, the latest observed candidate runs next. Watch settings and the last triggered SHA persist across restarts. Automated runs use deterministic checks; AI remains an explicit manual choice.

Triage never changes the original check result. It can change a current acceptance assessment by resolving or dismissing a finding; it cannot override a failed required check. A later passing check is a review hint, not automatic resolution. A resolved finding reopens when its signature recurs. Findings from harness/configuration problems are not automatically classified as product defects.

This interface is for one trusted local operator. It binds to loopback and protects mutations with same-origin checks and a session token. It does not implement multi-user authentication, shared hosting, PR webhooks, or deployment permissions. Do not expose it through a public tunnel. The AI configuration indicator reports whether environment variables are set, not whether provider credentials have been validated.

Dashboard state is stored in `.atm/runs/.dashboard/state.json`. Only one dashboard may own a history directory. Normal shutdown removes its lock and waits for active-run cleanup. After a crash, verify that the old process is stopped before removing `.dashboard/server.lock`. A run without a completion record is shown as **incomplete**, not passed.

## Requirements

- Node.js 22 or newer, npm, Git, and tar.
- Docker Engine/Desktop with Compose v2, running Linux containers.
- A local ImpactGraph checkout. The initial adapter targets revision `1d3bd1774a6f65398d8aed2bb6f58d9375794118`; pass `--revision` to pin it explicitly.
- Network access to install dependencies and build images. Runtime application containers have no external network access.

## Run

```sh
npm ci
npm exec playwright install chromium
npm run atm -- run --repo /Users/shawncoe/Documents/dev/ImpactGraph
```

Each run gets a unique directory under `.atm/runs/`, a Docker Compose project, a loopback-only ingress port, synthetic database credentials, and disposable PostgreSQL storage. The command prints the path to `report.html`. Open it locally in a browser. `run.json` includes the candidate revision, source archive hash, image IDs, policy, results and evidence hashes.

```sh
npm run atm -- inspect .atm/runs/RUN_ID/run.json
npm run atm -- run --repo /path/to/ImpactGraph --revision COMMIT_SHA --output /private/tmp/atm-runs
```

Only committed source is archived. Uncommitted changes, ignored files, local `.env` files, existing databases, and existing application servers are not used. Run-owned containers are removed even after a failed check or normal cancellation. Docker image tags, build cache, source archives, and evidence are retained for diagnosis.

## Checks implemented

1. Validate and archive the requested ImpactGraph commit.
2. Build its production API/frontend images and build-stage test images.
3. Start and migrate separate ephemeral PostgreSQL clusters for application acceptance and integration tests. Their roles cannot interfere with each other.
4. Run existing Go vet/race-enabled tests and frontend lint/unit/type checks. Biome's VCS discovery is disabled because the archived container source has no Git metadata; its lint rules remain enabled.
5. Start the production images with separate API/staff database roles and check readiness.
6. Drive the real staff UI with Chromium's virtual authenticator: activate a passkey, sign out, and sign back in.
7. Independently query persisted staff/passkey/session state in a read-only transaction. Check invitation replay, unauthenticated access, and public/staff host separation.
8. Claim a synthetic donor account through the real UI, reload the authenticated dashboard, verify the correct donor profile, sign out, and reject both replay of the used link and a sibling link. Read-only SQL verifies the claim, link consumption and session revocation, and that another donor is unchanged.
9. Optionally run bounded AI exploration of the guest donation entry point.
10. Collect evidence, remove the environment, evaluate check outcomes and assess local acceptance against the recorded policy.

The profile does **not** run the entire existing Playwright suite, external Stripe/mail flows, production nginx/TLS checks, vulnerability scans, performance tests, or production promotion. A passing report means its selected local checks passed, not that a production release is approved. Staff role-specific permission matrices remain a follow-up; current browser coverage checks authentication and host boundaries.

## Versioned acceptance policy

The default [policy](policies/impactgraph-local.json) identifies the ImpactGraph adapter, local acceptance scope, required checks, per-check time budgets, evidence filenames and blocking finding severities. It requires both the staff and donor journeys. Foundation checks and cleanup cannot be made advisory. Unknown fields, handlers, scenario versions, invalid time budgets and weakened evidence contracts are rejected before execution.

```sh
npm run atm -- run --repo /path/to/ImpactGraph --policy policies/impactgraph-local.json
npm start -- --repo /path/to/ImpactGraph --policy policies/impactgraph-local.json
npm run atm -- inspect .atm/runs/RUN_ID/run.json
```

Policies reference implemented, versioned [scenario definitions](src/scenarios.js). Each definition records its goal, preconditions, constraints, observable success criteria and failure criteria. These are descriptions of fixed handlers, not arbitrary instructions or code evaluated from configuration. Adding a new behavior requires implementing and testing a handler and versioning its definition. Bump the policy version when changing its contract; a content digest distinguishes changes even if a version label is accidentally reused.

Every new run records a complete effective policy and scenario snapshot with a canonical SHA-256 digest. AI command-line flags become part of that snapshot. The source commit, source archive hash and built image IDs identify the candidate. Policy time budgets bound the whole check; existing command limits may end a check earlier. Cleanup has its own deadline and still runs after cancellation.

There are two separate results:

- **Check outcome (`decision`):** whether the selected required checks passed, failed, were canceled or remained inconclusive.
- **Local acceptance (`release`):** whether a completed candidate satisfies the recorded policy, has complete and intact required evidence, and has no unresolved blocking findings. `productionAuthorized` is always false in this release.

Default finding policy blocks unresolved **unassessed**, **high** and **critical** findings for the same source repository, including historical findings and findings from other branches. A subsequent pass is a review hint, not automatic resolution. This is deliberately conservative: triage old harness issues as such, with a reason, rather than treating them as confirmed product defects. Advisory checks do not affect the check outcome, but their findings still need assessment under the finding policy.

Severity definitions: **critical** means credible account compromise, major data corruption/loss or broad service failure; **high** means a broken critical workflow or significant permission/integrity failure; **medium** means impaired behavior with a workable alternative; **low** means minor impact; **unassessed** means impact has not been reviewed. Confirmed, untriaged and reopened findings remain unresolved. Resolution or dismissal requires a reason, retained in the local triage audit. Repeated failures after resolution reopen the finding.

**Exceptions are disabled.** No approval button, note, or CLI flag can waive a required check, missing evidence or an unresolved blocking finding. An emergency override workflow with authenticated approvers is future work. The local single-operator audit is not a signed or tamper-proof approval system.

The completion-time assessment stays in `run.json` and the static HTML report. CLI inspection and the dashboard recompute a current assessment using the recorded policy, current evidence files and current finding assessments. They share the same evaluator; reassessment does not rewrite historical results. Deleting history or editing manifests is not a supported way to clear a blocker. Retain the run history and `.dashboard/state.json` together. Old runs without a full versioned policy remain viewable but are ineligible under this new assessment.

CLI exit codes: **0** locally eligible, **1** required check failed, **2** inconclusive or invalid evidence, **3** checks passed but acceptance blocked, **130** canceled. Automation should require exit code 0. This is a local decision contract; PR branch protection and production promotion enforcement are not connected yet.

The donor fixture seeds an unclaimed account and two hashed one-time links only in the disposable database. It validates redemption and session behavior, not payment checkout or email delivery. The browser cannot query the database; the runner independently checks persisted state. Screenshots, a browser trace and a three-stage verification record support the result.

## Optional AI exploration

Set `OPENAI_API_KEY` in your shell or secret manager and choose an explicit model that supports strict function calling through the Responses API. ATM does not load `.env` files or infer a model. No model calls happen in the default run.

```sh
npm run atm -- run --repo /path/to/ImpactGraph --ai --model YOUR_MODEL
```

The first scenario lets an agent find the donation form from the public home page. It receives a bounded accessibility snapshot and can select exact links/buttons or declare completion. Deterministic DOM checks validate its claim. This is goal-driven exploration, not the deterministic staff scenario relabeled as AI.

AI is advisory by default. Use `--require-ai` to include it in the local gate. Missing credentials, provider errors, time exhaustion, and action exhaustion produce **inconclusive** results. A rejected completion claim produces **failed**. Advisory failures remain visible but do not change the required-check decision.

Limits: 12 model requests/actions, 180 seconds, 12,000 snapshot characters per observation, and at most 800 output tokens per request. These are resource caps, not a currency budget. Model input includes synthetic public-page content. Requests use `store: false`; consult your provider's account data-retention settings. The API key is never passed to the browser or application containers.

## Isolation and evidence

Application runtime containers share an internal Docker network. Only a fixed-target nginx ingress proxy joins an additional edge network and publishes a loopback port; the web application, PostgreSQL and API publish none. Stripe, SMTP, push and application workers are disabled in this first profile. Browser contexts block service workers, WebSockets, off-origin HTTP requests (including redirect hops) and, for AI exploration, non-read methods. The model cannot run code, query the database, issue arbitrary HTTP requests, read files or operate Docker.

This is intended for **trusted application source with synthetic data**. Docker builds and dependency lifecycle scripts execute repository code. Browser request interception is an additional guard, not an OS-level browser sandbox or a guarantee against malicious application code. Use dedicated isolated execution hosts before supporting untrusted repositories or applications.

Text logs redact common credentials. Browser traces can contain synthetic one-use invitations and session cookies; treat all run directories as private. Files are created with restrictive permissions, and `.atm/` is ignored by Git. Reports are not uploaded anywhere. Do not publish raw traces. Evidence is hashed for comparison, not signed or tamper-proof.

Ctrl-C and SIGTERM trigger cleanup. SIGKILL, host failure, or an unavailable Docker daemon can interrupt cleanup. The report records cleanup failure. For a run you own, recover with:

```sh
docker compose -p RUN_ID -f .atm/runs/RUN_ID/compose.json down --volumes --remove-orphans
```

Do not run global Docker prune commands to clean an ATM run. Retention is manual in this release; remove only the completed run's directory and its four `RUN_ID/*:local` image tags when no longer needed.

## Development

```sh
npm run check
npm test
npm run test:browser
```

To verify the complete dashboard-to-ImpactGraph path, start the dashboard and run `npm run test:live`. This launches a real validation from the browser and waits for its evidence. Screenshots and the acceptance result are saved under `.atm/ui/`. The live test is explicit and is not part of routine CI.

Unit and integration tests exercise versioned policy validation, missing or modified evidence, finding-based acceptance, agreement between CLI and dashboard assessments, donor state invariants, fail-closed decisions, evidence persistence, secret filtering, command failures/timeouts/cancellation, isolation configuration, model-action validation, independent verification, finding deduplication, persistent triage, request protection, and commit-watch behavior. Browser tests cover the dashboard's full interaction flow, responsive layout and automated accessibility checks on the overview, evidence dialog, finding dialog and mobile findings view, including a passing-checks/blocked-acceptance case after evidence modification, plus real request blocking and the exploration loop, without API charges.

API implementation references: [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling), [Playwright BrowserContext](https://playwright.dev/docs/api/class-browsercontext), and [Docker Compose internal networks](https://docs.docker.com/reference/compose-file/networks/).

## Next increments

- Expand deployed acceptance scenarios: role-specific staff permissions, referral attribution, recurring gifts, worker recovery.
- Add sandbox Stripe and captured-email services with explicit egress rules.
- Adapt the existing full Playwright suite to deployed targets and ingest structured suite results.
- Add security, accessibility and representative load gates to the required policy.
- Resolve ImpactGraph's build-time origin configuration before same-image staging/production promotion.
- Add evidence retention, richer finding extraction, PR/staging triggers and an authenticated shared deployment.
- Add production deployment and recovery automation only after staging evidence and rollback compatibility are established.
