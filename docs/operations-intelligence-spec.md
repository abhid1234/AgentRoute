# Operations intelligence

AgentRoute's operations-intelligence plane turns routing receipts into three
reviewable, offline artifacts. It does not proxy inference, call a provider, or
apply a policy.

## 1. Routing drift

`ar drift` compares two conformant ledgers and answers whether the routing mix
or measured outcomes moved beyond preregistered limits.

The report includes:

- total-variation distance across selected model/provider identities;
- the largest individual selection-share change;
- newly selected and no-longer-selected identities;
- observation coverage and measured failure, latency, cost, and quality deltas;
- the same analysis for every task type present in either ledger; and
- deterministic pass, fail, or insufficient-evidence checks.

Drift is descriptive evidence, not proof of causality. Task-volume changes,
traffic mix, router changes, and provider behavior can all contribute. The
command therefore keeps distribution checks separate from measured-outcome
checks and exposes every threshold in a JSON configuration file.

## 2. Resilience scenarios

`ar scenario` stress-tests the candidate and fallback evidence that already
exists in a ledger. A scenario may declare unavailable providers or models and
provider/model-specific cost and latency multipliers.

Selection follows the recorded order: selected candidate, declared
`fallback_order`, then remaining candidates sorted by candidate ID. AgentRoute
chooses the first recorded, eligible, available candidate that satisfies the
scenario criteria. It never invents an unrecorded provider or claims the
fallback is optimal.

The report identifies changed selections, stranded routes, projected cost and
latency deltas, incomplete-evidence skips, and routes whose selected candidate
lacks required estimates. It is a predicted stress test over routing-time
evidence, not a live availability probe or counterfactual outcome claim.

## 3. Incident forensics

`ar incident analyze` produces a deterministic JSON incident index, while
`ar incident open` writes a standalone HTML review page with no scripts,
network calls, remote assets, prompts, or response bodies.

Findings cover:

- failed, partial, cancelled, or missing outcomes;
- actual model/provider mismatches that can reveal fallback execution;
- measured cost, latency, and quality breaches against the decision criteria;
- selection-time policy violations;
- incomplete candidate evidence and missing fallback visibility.

Each finding has a stable ID, severity, route ID, category, summary, and
evidence facts. Findings are operational leads, not automatic root-cause
determinations.

## Shared safety and determinism contract

- Inputs must pass the AgentRoute ledger validator before analysis.
- Configuration rejects unknown keys and non-finite or out-of-range values.
- Output ordering is stable and timestamps are caller-injected for tests.
- Unknown or missing evidence is reported explicitly and never treated as zero.
- No command mutates a ledger, calls a vendor, or applies a routing policy.
- JSON and HTML output exclude arbitrary extensions, errors, prompts, outputs,
  credentials, endpoints, and request metadata.

## Acceptance criteria

1. Identical ledgers pass a configured drift check; material distribution or
   measured regression fails; low sample/observation coverage is insufficient.
2. An outage scenario uses only recorded fallback evidence, reports stranded
   routes, applies scoped multipliers, and skips non-full candidate sets.
3. Incident analysis detects every supported category without retaining
   sensitive error or extension values; HTML is standalone and script-free.
4. All three workflows are available from the CLI and typed library surface.
5. Adversarial validation, deterministic-output, CLI, and privacy tests pass.
