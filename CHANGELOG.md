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

### Security

- Prompts, responses, endpoints, credentials, evaluator reasoning, and unknown
  metadata are excluded from portable evidence and telemetry exports.
- Publication remains disabled by `private: true` until human release approval.
