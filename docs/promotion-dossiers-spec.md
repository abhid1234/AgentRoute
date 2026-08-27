# AgentRoute promotion dossiers specification

Status: implemented in AgentRoute v0.2.0.

## Product boundary

This increment turns measured replay evidence into a review packet without
turning AgentRoute into a deployment system. An experiment protocol declares
success criteria before results are analyzed. A promotion dossier binds that
protocol, its deterministic decision, a reviewed policy, routing quality-gate
results, and dry-run vendor compilations into one tamper-evident local artifact.

AgentRoute still does not apply provider configuration, authenticate approvers,
contact model vendors, or merge code.

## 1. Preregistered experiment protocol

An experiment protocol has a stable ID, one baseline candidate, one challenger,
minimum matched-pair coverage, quality success thresholds, optional latency,
cost, and success-rate guardrails, and optional required task-type slices.

The protocol must declare at least one quality success threshold:

- minimum challenger mean quality delta; or
- minimum lower bound of the challenger quality win-rate Wilson 95% interval.

The same thresholds apply globally and to every required task-type slice. This
prevents a global average from concealing a known workload regression.

## 2. Experiment decision

`ar experiment decide <replay-ledger> --protocol <protocol.json>` produces a
deterministic decision with one of three states:

- `pass`: every declared check passes;
- `fail`: at least one measured result violates a threshold; or
- `insufficient`: no measured failure exists, but required evidence is missing.

Failure takes precedence over insufficient evidence so an observed regression
cannot be hidden by low coverage. Every check records its scope, measured value,
operator, threshold, and an explicit message. The decision binds to SHA-256
fingerprints of both the protocol and replay records. It never claims causality.

## 3. Promotion dossier

`ar promotion create` requires:

- a replay ledger and experiment protocol;
- a candidate policy in `reviewed` status;
- baseline and current route ledgers plus a quality-gate configuration; and
- at least one supported dry-run compiler target.

The dossier verdict is:

- `eligible` only when the experiment passes, the route gate passes, and the
  policy is reviewed;
- `blocked` when the experiment or route gate fails, or policy state is wrong;
  or
- `insufficient` when experiment evidence or the route gate is neutral.

The artifact contains sanitized policies, optional policy diff, experiment
checks and aggregate analysis, gate metrics, and deterministic dry-run compiler
outputs. It never contains route records, task descriptions, prompts, model
responses, credentials, endpoints, arbitrary metadata, or policy descriptions.

## 4. Integrity and review UI

An `.arpromote` file is canonical JSON with payload and root SHA-256 hashes.
Verification recomputes hashes, experiment/protocol bindings, policy diffs,
compiler outputs, and the promotion verdict. A verified dossier can render a
self-contained offline HTML review page with no remote assets or network calls.

Hashes detect modification but do not establish authorship. Existing signed
`.arcap` capsules remain the authenticated portable evidence primitive.

## Acceptance criteria

- Zero runtime dependencies and Node 20+ support remain unchanged.
- Existing receipts, unsigned or signed capsules, policies, gates, and replay
  reports remain compatible.
- Protocol validation and decision precedence have adversarial tests.
- Dossier verification rejects hash, compiler, policy-diff, and verdict drift.
- CLI tests exercise decide, create, verify, and offline HTML rendering.
- Build, behavioral tests, conformance, package inspection, and hosted CI pass.
- No live provider call, account mutation, configuration apply, deployment, or
  merge occurs during implementation or verification.
