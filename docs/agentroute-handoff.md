# AgentRoute handoff for UI and launch work

Status: v0.2.0 release line; verify repository, package, and deployment state
independently.

## Product sentence

AgentRoute is the open receipt layer for AI model routing: it records which
models were considered, why one was selected, what actually happened, and how a
different policy would have scored the same known candidate set.

## Stable application surfaces

- `ar route explain` produces a human-readable decision narrative with policy
  violations and evidence-fidelity caveats.
- `ar route replay` produces deterministic aggregate JSON for cards and charts.
- `ar route simulate --policy` produces policy-comparison JSON and explicitly
  marks incomplete evidence as skipped.
- `ar export otel-genai` produces OTLP/JSON without task descriptions,
  endpoints, prompts, extensions, or source envelopes.
- `ar ops create|verify|open` produces a point-in-time, tamper-evident routing
  operations review over sanitized evidence.
- `ar history create|append|verify|open` produces an append-only reliability
  timeline with deterministic trend signals and standalone HTML.
- `ar proof run|verify` produces the deterministic 31-artifact launch showcase,
  connecting experiment, promotion, operations, resilience, connector, and
  reliability evidence without accounts or network calls.
- `ar proof sign` creates a detached Ed25519 attestation only after the full
  pack verifies; `ar proof verify --attestation --public-key` pins signer trust.
- `ar proof diff` validates two complete packs before reporting root, artifact,
  and bounded semantic changes; `--fail-on-change` turns that review signal into
  an explicit CI gate.
- `.github/actions/agentroute-proof` enforces unsigned, signed, or
  trusted-signature proof verification in CI and emits the verified root.
- `examples/model-routing.route.jsonl` is the sanitized demo fixture.

The UI can remain a static file reader like the OpenTrajectory Inspector. It
does not need a database, provider key, or model call.

## Suggested Inspector views

1. **Decision** — selected model, reason, confidence, policy, and task type.
2. **Candidate matrix** — eligibility, predicted quality/latency/cost, component
   scores, selected marker, and rejected reasons.
3. **Outcome** — measured status/latency/cost/quality linked to its trajectory.
4. **Evidence badge** — Full, Partial, or Selected only. Never display a missing
   candidate as rejected.
5. **Policy lab** — local sliders or a policy JSON upload backed by simulation
   output. Label all differences “predicted.”
6. **Replay** — selection share, outcome coverage, success rate, mean observed
   metrics, and policy violations.

## UX truth constraints

- Do not imply AgentRoute executes requests or chooses models; it records and
  audits decisions made elsewhere.
- Do not call predicted score delta “savings,” “quality gain,” or “regret.”
- Do not rank alternatives on partial or selected-only evidence.
- Keep predicted candidate estimates visually separate from measured outcomes.
- Never render source `extensions` or unknown metadata by default.

## Verification commands

```bash
npm run build
npm test
npm run conformance
npm run test:examples
npm run test:action
npm run test:package
node dist/cli.js proof run --out local/proof-pack
node dist/cli.js proof verify local/proof-pack
node dist/cli.js proof diff artifacts/previous-proof local/proof-pack
node dist/cli.js route explain examples/model-routing.route.jsonl
node dist/cli.js route simulate examples/model-routing.route.jsonl --policy examples/fast-cheap-policy.json
```

No launch claim should say the npm package, UI, or repository update is live
until that publication is independently verified.
