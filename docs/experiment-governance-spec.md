# AgentRoute experiment governance specification

Status: implementation target for `codex/experiment-governance`.

## Product boundary

This increment turns replay receipts into reviewable experiments and policy
governance without turning AgentRoute into a production router. Analysis is
deterministic and local. Registry changes are explicit file operations. Capsule
signing reads caller-owned keys but never generates, uploads, or logs them.

## 1. Paired replay experiments

`ar experiment analyze <replay-ledger>` groups Arena receipts by original route
and candidate. It produces:

- candidate sample, success, quality, latency, and cost aggregates;
- pairwise comparisons for candidates measured on the same original tasks;
- wins, losses, ties, mean deltas, and a Wilson 95% interval for non-tied wins;
- per-task-type slices; and
- explicit warnings when pairing or metric coverage is incomplete.

Quality is higher-is-better. Latency and cost are lower-is-better. A tie uses a
caller-supplied non-negative tolerance. The report does not infer causality and
does not call an evaluator or model.

## 2. Durable policy registry

A registry is one canonical JSON file containing policies and append-only
lifecycle events. Supported operations are init, add, list, and transition.

Allowed transitions are:

```text
draft -> reviewed -> approved -> deprecated
```

Skipping states and leaving `deprecated` are refused. `approved` requires an
explicit human attestation flag, actor, and non-empty reason. Registry writes
use a same-directory temporary file plus atomic rename. They never compile or
apply a vendor configuration.

The attestation records that the caller asserts a human approved the transition;
it is not authentication or proof of the actor's identity. Deployments that need
identity assurance must put the CLI behind their own authenticated review gate.

## 3. Signed evidence capsules

An optional Ed25519 signature authenticates the existing capsule root hash.
Signing accepts a PEM private key and embeds only the public key, its SHA-256
fingerprint, and the base64 signature. Verification first validates capsule
integrity and derived reports, then verifies the signature. Unsigned capsules
remain valid for backward compatibility and can be rejected with a
`require_signature` option.

Private keys are never written by AgentRoute, copied into artifacts, or printed.

## 4. Slice-aware quality gates

Gate configuration may require the same cost, latency, quality, and sample
thresholds for every task-type slice present in either baseline or current
evidence. Missing slices fail closed by default. The result includes slice IDs
on every metric so GitHub annotations identify the affected workload instead
of hiding regressions behind a global average.

## Acceptance criteria

- Zero runtime dependencies; Node 18+ remains supported.
- Existing unsigned capsules, policies, global gates, and replay ledgers remain
  compatible.
- Statistical results are deterministic and refuse malformed Arena metadata.
- Registry transitions and capsule signatures have adversarial tests.
- CLI examples exercise the complete offline workflow.
- Build, behavioral tests, conformance, package inspection, and hosted CI pass.
- No live provider call, policy apply, deployment, merge, or account mutation.
