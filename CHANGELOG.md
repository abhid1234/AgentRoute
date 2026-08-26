# Changelog

AgentRoute follows Semantic Versioning. The project is not yet publicly
released; entries below describe the intended first public release line.

## Unreleased — target 0.2.0

### Added

- Deterministic routing receipts, replay analytics, Decision Lab, and audit
  readiness reports.
- Metadata-only integrations for OpenRouter, LiteLLM, Portkey, Vercel AI
  Gateway, Cloudflare AI Gateway, Exa, and Braintrust.
- Shadow Replay Arena, paired experiments, preregistered decisions, quality
  gates, policy lifecycle, dry-run compilers, evidence capsules, and promotion
  dossiers.
- Reproducible Public Proof Pack with a standalone HTML report and fail-closed
  verification.
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
- Collision-free npm package candidate `agentroute-evidence`; the AgentRoute
  project name and `ar` binary remain unchanged.

### Security

- Prompts, responses, endpoints, credentials, evaluator reasoning, and unknown
  metadata are excluded from portable evidence and telemetry exports.
- Publication remains disabled by `private: true` until human release approval.
