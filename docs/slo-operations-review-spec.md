# Routing SLOs and operations review bundles

This milestone adds a reliability contract and a portable review artifact to
AgentRoute's read-only evidence plane. It does not proxy inference, probe a
provider, mutate a ledger, or apply a policy.

## Routing service-level objectives

`ar slo evaluate` measures a conformant ledger against a preregistered JSON
contract. A routing SLO may set:

- minimum sample and observation coverage;
- minimum successful-outcome rate;
- maximum measured p95 latency and p95 cost;
- minimum measured p10 quality;
- maximum selection-time policy-violation rate; and
- optional task-type slices with their own minimum sample floor.

Latency, cost, and quality each carry separate measurement coverage. A present
observation with no cost does not count as cost evidence. Percentile checks are
therefore `insufficient`, never zero or passing, when their configured evidence
floor is not met.

The success objective also reports an error budget: allowed unsuccessful
outcomes, consumed budget, remaining budget, and finite burn ratio when the
target leaves a nonzero budget. `partial`, `cancelled`, `unknown`, and `failure`
are all unsuccessful for this calculation.

Every global and task-type check is deterministic and has one of three states:

- `pass` — enough evidence exists and the objective is satisfied;
- `fail` — enough evidence exists and the measured objective is missed; or
- `insufficient` — the sample or measurement coverage is too small to judge.

Measured failure outranks missing evidence in the overall result.

## Operations review bundle

`ar ops create` combines one baseline ledger, one current ledger, one drift
configuration, one SLO configuration, and zero or more resilience scenarios
into a canonical `.arops` file.

The bundle contains:

- sanitized baseline and current evidence capsules;
- routing drift and task-slice checks;
- the current-ledger SLO/error-budget result;
- the current-ledger incident index;
- each requested resilience scenario report; and
- a derived operational assessment with reasons.

The assessment is `critical` when a drift or SLO check fails, incident analysis
is critical, or a scenario strands a route. It is `insufficient` when required
evidence is missing, `attention` for noncritical findings or scenario impact,
and `clear` otherwise.

The manifest binds the canonical payload SHA-256 and a root SHA-256 over the
format version, creation time, payload hash, and scenario count. `ar ops verify`
validates both embedded capsules, recomputes every derived report and the
assessment, and then validates both hashes. Hash integrity is not signer
identity; a later milestone may add an explicit signature contract.

`ar ops open` verifies first and then writes a standalone HTML review with no
scripts, remote assets, network requests, prompts, outputs, errors, endpoints,
credentials, or arbitrary extensions.

## Acceptance criteria

1. SLO evaluation passes, fails, and reports insufficient evidence without
   conflating absent metrics with zero.
2. Error-budget math and nearest-rank percentiles are deterministic globally
   and by task type.
3. Bundle verification rejects capsule, report, assessment, payload-hash, and
   root-hash tampering.
4. Bundle creation strips private descriptions, endpoints, errors, metadata,
   and extensions by reusing the evidence-capsule allowlist.
5. CLI tests cover `slo evaluate` and `ops create|verify|open` end to end.
6. The installed npm tarball exposes the typed APIs and command help.
