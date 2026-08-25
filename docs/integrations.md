# AgentRoute integration plane

AgentRoute integrates at evidence boundaries, not by taking over inference. A
gateway can contribute a decision receipt, an evaluator can append an
observation, and a telemetry backend can receive a sanitized span. Policy
changes flow back only through a reviewed dry-run compiler and a separate human
apply step.

Run `ar connectors` for the catalog embedded in the release. `READY` means all
listed paths are tested. A `policy-export` capability means AgentRoute can
compile a local review artifact; it never means the vendor configuration was
applied.

| System | Role | State | Most useful AgentRoute surface |
|---|---|---:|---|
| Application-native router | Router | Ready | Emit the JSON/JSONL receipt contract directly |
| OpenRouter | Router, gateway, and policy target | Ready | Metadata import, explicit capture, and dry-run provider preferences |
| LiteLLM | Router, gateway, and policy target | Ready | Metadata import and dry-run proxy config |
| Exa | Task source | Ready | Fresh, source-linked evaluation task packs |
| OpenTelemetry | Telemetry | Ready | Privacy-safe routing-decision span export |
| Portkey | Gateway and policy target | Ready | Evidence import and review-only routing config artifact |
| Vercel AI Gateway | Gateway and policy target | Ready | Evidence import and review-only AI SDK provider options |
| Cloudflare AI Gateway | Gateway and telemetry | Ready | Log import into decisions plus measured operational observations |
| Braintrust | Evaluator and telemetry | Ready | Numeric experiment and online-score evaluation import |

## Why these additions

- **Portkey** supplies selected model/provider, fallback, retry, cache, latency,
  and cost evidence. AgentRoute imports those facts from saved logs or response
  envelopes; it does not become the gateway or require a Portkey account.
- **Vercel AI Gateway** supplies provider filtering, ordering, fallback models,
  and the selected provider/model. The importer recognizes conservative field
  aliases across saved log and provider-metadata envelopes.
- **Cloudflare AI Gateway** supplies documented log fields for status, latency,
  cache, token counts, provider, and model. Because logs can contain prompts
  and responses, the importer discards the source envelope and arbitrary
  metadata. An ambiguous `cost` field is not treated as USD; only `cost_usd`
  is imported as dollars.
- **Braintrust** treats evaluation experiments as immutable comparable records
  and supports online scoring. AgentRoute imports evaluator identity, version,
  numeric 0..1 scores, timestamp, and external span reference only.
- **OpenTelemetry** remains the neutral outbound seam. The GenAI conventions
  warn that message and tool attributes may contain sensitive content, so
  AgentRoute's export stays narrower than a general LLM trace.

## Provider layer

OpenAI, Anthropic, Google, xAI, Amazon Bedrock, Azure AI, Fireworks, Together,
Groq, and other model hosts sit behind the router/gateway boundary. AgentRoute
records the chosen model and provider when exposed; it does not require a
provider-specific SDK or hold provider credentials.

## Adapter acceptance contract

A new adapter is not `READY` until it has all of the following:

1. an allowlist mapper that discards source envelopes, credentials, prompts,
   responses, headers, and unknown fields;
2. an explicit fidelity rule (`selected-only`, `partial`, or `full`);
3. adversarial fixtures proving secrets and HTML payloads do not cross the
   boundary;
4. stable IDs for decision and observation idempotency;
5. a documented upstream API/version assumption;
6. conformance and CLI coverage.

## Offline import commands

No vendor keys are read by these commands. Export or save the source JSON using
the vendor's own tooling, then run:

```bash
ar route import portkey portkey-event.json -o decision.route.json
ar route import vercel-ai-gateway vercel-event.json -o decision.route.json
ar route import cloudflare-ai-gateway cloudflare-log.json -o decision.route.json

# Writes a decision and, when metrics exist, one observation.
ar ingest portkey portkey-event.json --ledger routes.route.jsonl
# If an older export uses generic `cost` in cents, attest the unit explicitly:
ar ingest portkey portkey-event.json --portkey-cost-unit cents --ledger routes.route.jsonl
ar ingest vercel-ai-gateway vercel-event.json --ledger routes.route.jsonl
ar ingest cloudflare-ai-gateway cloudflare-log.json --ledger routes.route.jsonl

# Appends a score observation to an existing route.
ar evaluate braintrust braintrust-score.json --ledger routes.route.jsonl
```

Use `--complete-candidates` only when the source candidate list is a complete
routing-time snapshot. Otherwise the importer records `partial` or
`selected-only` fidelity and blocks unsupported counterfactual claims.

## Dry-run policy compilers

Policy compilation is local and credential-free. Every artifact carries its
source policy ID, semantic version, SHA-256 fingerprint, `dry_run: true`, an
official documentation link, and target-specific caveats.

```bash
ar policy validate examples/evidence-suite.policy.json
ar policy compile examples/evidence-suite.policy.json --target openrouter
ar policy compile examples/evidence-suite.policy.json --target litellm
ar policy compile examples/evidence-suite.policy.json --target portkey
ar policy compile examples/evidence-suite.policy.json --target vercel-ai-gateway
```

The Portkey output is deliberately labeled as a review artifact because
workspace integration IDs and the exact apply API are account-specific. No
compiler reads a vendor token or performs a network request.

## Accepted source fields

The adapters intentionally support a small, explicit surface. Unknown fields
are dropped, not copied into `extensions`.

| Source | Decision allowlist | Observation allowlist | Unit assumptions |
|---|---|---|---|
| Portkey | trace ID, model, provider, fallback models, retry/cache/option index, config ID | status, response time, direct `cost_usd`, explicitly unit-tagged generic `cost`, token counts | `response_time` is milliseconds; generic `cost` is omitted unless `--portkey-cost-unit usd|cents` is supplied |
| Vercel AI Gateway | request ID, model, selected provider, provider `order`/`only`, fallback models | status, `latency_ms`, `cost_usd`, token counts | no generic `cost` field is interpreted |
| Cloudflare AI Gateway | log ID, timestamp, model, provider, explicitly supplied candidates | success/status, duration, `cost_usd`, token counts, cache state | `duration` is milliseconds; generic `cost` is omitted because export units may vary |
| Braintrust | route ID, evaluator/experiment identity, evaluator version, timestamp, span ID, numeric scores | mapped 0..1 quality and safe check summaries | default pass threshold is 0.5; the numeric score itself remains authoritative |

The Vercel importer accepts both snake-case and camel-case aliases because
saved AI SDK provider metadata and exported gateway logs use different envelope
shapes. This is a compatibility layer, not a promise to retain the original
document.

Official references: [Portkey response schema](https://portkey.ai/docs/api-reference/inference-api/response-schema),
[Portkey logs](https://portkey.ai/docs/product/observability/logs),
[Vercel AI Gateway provider options](https://vercel.com/docs/ai-gateway/models-and-providers/provider-options),
[Cloudflare AI Gateway logs API](https://developers.cloudflare.com/api/resources/ai_gateway/subresources/logs/),
[Cloudflare logging](https://developers.cloudflare.com/ai-gateway/observability/logging/),
[Braintrust evaluations](https://www.braintrust.dev/docs/evaluate), and
[OpenTelemetry GenAI attributes](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/).
