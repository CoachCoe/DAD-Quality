# Performance baseline and burst testing

Policy `impactgraph-local` 1.1.0 adds an advisory `performance` check after the
functional journeys. It runs automatically in the CLI, dashboard and GitHub
workflow once that workflow pins this ATM version. Existing 1.0.0 policy snapshots
remain supported. Required-check branch protection remains deferred.

## Workload

`donor-reads-v1` creates 12 separate synthetic donors, each with one browser session
and 60 one-time gifts (720 gifts total), directly in the run-owned database. These
are setup fixtures, not real payments or evidence of checkout correctness. The
functional authentication fixtures remain separate. Workers and external services
remain disabled.

Traffic uses an equal, deterministic mix of public spend-by-category totals, authenticated donor
dashboards and authenticated first-page giving history. Donors rotate across the
requests. GETs pass through loopback ingress and the production web/API images.
The runner checks HTTP 200, JSON shape and full response completion. It does not
follow redirects, send mutations or contact arbitrary targets. Session tokens stay
in memory and never enter performance reports.

| Phase | Concurrent users | Duration |
| --- | ---: | ---: |
| Warm-up | 2 | 3 seconds |
| Baseline | 2 | 10 seconds |
| Burst | 12 | 10 seconds |
| Recovery | 2 | 10 seconds |

Each user waits 25 ms between requests. These are closed-loop users: a user waits
for its response before sending another request. The workload therefore reduces
its offered rate when responses slow down; it does not model a fixed arrival rate
or establish overload capacity. Phase durations are launch windows; in-flight
requests may take up to the 1.5-second request timeout to drain before the next
phase. Warm-up is reported separately and excluded from assessment/comparison.
The initial burst is a small concurrency spike, not a production traffic model.

Safety bounds are enforced before execution: at most 32 concurrent requests,
10,000 requests per phase, 120 seconds of configured load, 5 seconds per request
and 256 KiB per response. Reaching the request cap makes the result inconclusive.
Cancellation closes connections; normal run cleanup still removes the containers.

## Evidence and comparison

Every completed measurement writes hashed `evidence/performance.json`, including
its full profile, workload digest, environment metadata/digest, phase durations,
request counts and per-route metrics:

- p50, p95 and p99 latency, measured through response-body completion with a
  monotonic clock and nearest-rank percentiles. Failed attempts are included.
- Total attempted and successful requests per second, using actual elapsed time.
- Error rate, timeout count and HTTP status counts (status 0 is a transport failure
  before response headers).

The dashboard's run detail shows phase metrics, budgets and comparison with the
latest earlier complete report for the same source and adapter whose workload and
environment digests match. Environment metadata includes host CPU model/count,
architecture, platform, memory, Node major version and Docker resources/version.
Changed or missing evidence is not used for comparison. A corrupt earlier report
stops baseline selection and is reported instead of silently skipping it.

Regression signals are advisory: p95 rises by more than 50% and at least 20 ms,
successful throughput falls by more than 25%, or error rate rises. The profile
versions these criteria. Each phase and each route is compared independently.
These signals do not prove statistical significance. A matching environment is a
necessary comparison filter, not a guarantee of equal contention or cloud hardware
performance. Small sample counts make p99 particularly noisy. Repeat measurements
before treating a signal as a confirmed defect.

GitHub retains the report inside the existing encrypted evidence bundle. Its
persistent ledger records required-check findings, not performance samples. This
increment compares reports available in one local dashboard history; it does not
automatically download earlier GitHub artifacts. Decrypt downloaded runs and place
each under its own manifest run ID in a separate dashboard history to compare
compatible CI candidates. Do not mix decrypted CI findings with the authoritative
GitHub triage ledger.

## Acceptance criteria

The default policy requires at least 20 requests per measured phase and at least
one request to every route. Latency and error budgets are initially `null`; a
completed sufficient measurement is **observed**, not a performance approval.
Configured budgets produce **within-budget** or **exceeded**; interruption, caps
and insufficient samples produce **inconclusive**.

Edit a copy of the versioned policy to set `profile.criteria.maxP95Ms` and
`maxErrorRate` after establishing a baseline (rates are fractions from 0 to 1).
Bump the policy version and run with `--policy PATH`. Only set `required: true`
when both budgets are explicit and reviewed. Required failures block acceptance.
Advisory performance failures and execution issues remain visible in run details
but do not create blocking findings. Evidence corruption still blocks integrity
verification, even for advisory evidence. Existing non-performance finding rules
are unchanged. Triage cannot waive a required performance failure.

## Verification and limits

Automated HTTP fixture tests inject slow response bodies, 503s, redirects, malformed
JSON, oversized bodies and stalled responses. They verify regression detection,
request limits, cancellation, policy bounds, evidence integrity and advisory
semantics. Browser tests cover comparison, mobile layout, accessibility and
removal of untrusted metrics after evidence changes.

This is a read-workload regression baseline. It does not exercise write load,
referral capture, worker backlog, payment/email services, production-scale data,
CPU/memory utilization sampling, database saturation, soak or capacity testing.
Those require additional workloads and representative staging infrastructure.
Implementation reference: [Node HTTP client and connection pooling](https://nodejs.org/api/http.html).
