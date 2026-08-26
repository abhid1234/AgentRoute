# Changelog

AgentRoute follows Semantic Versioning.

## 0.2.0 - 2026-08-26

### Added

- Deterministic routing receipts, replay analytics, Decision Lab, and audit
  readiness reports.
- Metadata-only integrations for OpenRouter, LiteLLM, Portkey, Vercel AI
  Gateway, Cloudflare AI Gateway, Exa, and Braintrust.
- Shadow Replay Arena, paired experiments, preregistered decisions, quality
  gates, policy lifecycle, dry-run compilers, evidence capsules, and promotion
  dossiers.
- Reproducible 31-artifact Launch Showcase with connected experiment,
  promotion, operations, outage-resilience, connector, and longitudinal
  reliability evidence; three standalone HTML review surfaces; and fail-closed
  verification.
- Detached Ed25519 proof-pack attestations with strict subject binding,
  invalid-pack refusal, deterministic signatures, and explicit separation of
  embedded-key validity from caller-pinned signer trust.
- Reusable proof-verification GitHub Action with optional trusted-signature
  enforcement, verified-root outputs, caller-relative paths, and an
  injection-safe fixed Node runner.
- Verified proof-pack comparison with deterministic JSON, escaped GitHub
  annotations, explicit fail-on-change CI behavior, and strict v0.1 artifact
  membership enforcement.
- OpenTelemetry GenAI and OpenInference export profiles.
- Connector SDK conformance contract and native reference adapter.
- Explicit offline-versus-user-supplied evidence provenance on Replay Arena
  reports, with a budget-bounded live executor contract.
- Routing drift reports with model/provider distribution distance, measured
  outcome deltas, preregistered limits, and task-type slices.
- Read-only resilience scenarios for provider/model outages and cost or latency
  shocks over recorded fallback evidence.
- Privacy-safe incident forensics in deterministic JSON and standalone HTML.
- Deterministic routing SLO evaluation with sample and metric-coverage guards,
  task slices, nearest-rank tail metrics, and error-budget accounting.
- Tamper-evident `.arops` operations reviews that bind sanitized ledgers to
  recomputed drift, SLO, incident, and resilience evidence plus standalone HTML.
- Append-only `.arhistory` reliability timelines with strict chronology,
  per-entry hash chaining, atomic writes, operational trend signals, metric
  deltas that preserve missingness, and standalone HTML review.
- Collision-free npm package candidate `agentroute-evidence`; the AgentRoute
  project name and `ar` binary remain unchanged.

### Security

- Prompts, responses, endpoints, credentials, evaluator reasoning, and unknown
  metadata are excluded from portable evidence and telemetry exports.
- Public publication requires an explicit release commit and authenticated
  registry action; pull requests and ordinary CI cannot publish.
