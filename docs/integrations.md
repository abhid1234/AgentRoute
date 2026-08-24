# AgentRoute integration plane

AgentRoute integrates at evidence boundaries, not by taking over inference. A
gateway can contribute a decision receipt, an evaluator can append an
observation, and a telemetry backend can receive a sanitized span. Policy
changes flow back only through a reviewed export adapter.

Run `ar connectors` for the catalog embedded in the release. `READY` means the
repository contains a tested path. `PLANNED` means the external system has a
useful contract surface, but no working adapter is claimed yet.

| System | Role | State | Most useful AgentRoute surface |
|---|---|---:|---|
| Application-native router | Router | Ready | Emit the JSON/JSONL receipt contract directly |
| OpenRouter | Router and gateway | Ready | Metadata import and explicit non-streaming capture |
| LiteLLM | Router and gateway | Ready | Callback/logging metadata import |
| Exa | Task source | Ready | Fresh, source-linked evaluation task packs |
| OpenTelemetry | Telemetry | Ready | Privacy-safe routing-decision span export |
| Portkey | Gateway and policy target | Planned | Retry, fallback, conditional-route evidence and reviewed config export |
| Vercel AI Gateway | Gateway and policy target | Planned | Provider order, provider filtering, and fallback evidence |
| Cloudflare AI Gateway | Gateway and telemetry | Planned | Retry, fallback, cache, cost, error, and latency observations |
| Braintrust | Evaluator and telemetry | Planned | Immutable experiment scores and online evaluation observations |

## Why these additions

- **Portkey** exposes routing primitives such as fallbacks, conditional routes,
  retries, circuit breakers, and canary tests. Those are valuable receipt
  evidence, but AgentRoute should not become the gateway.
- **Vercel AI Gateway** exposes provider filtering, ordering, and fallback
  controls across multiple providers. A future adapter can explain which
  ordering was requested and which provider actually handled the call.
- **Cloudflare AI Gateway** exposes logs, analytics, cost, error, caching, and
  OpenTelemetry surfaces. Its logs may include prompts and responses, so an
  AgentRoute adapter must remain allowlist-only and default to excluding
  content.
- **Braintrust** treats evaluation experiments as immutable comparable records
  and supports online scoring. AgentRoute can import only the evaluator ID,
  version, score, and external reference needed for an observation.
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

Official references: [Portkey AI Gateway](https://portkey.ai/docs/product/ai-gateway),
[Vercel AI Gateway](https://vercel.com/docs/ai-gateway/models-and-providers/provider-options),
[Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/),
[Braintrust evaluations](https://www.braintrust.dev/docs/evaluate), and
[OpenTelemetry GenAI attributes](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/).
