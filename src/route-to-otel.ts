// AgentRoute -> OTLP/JSON GenAI decision span. The mapping uses GenAI semantic
// attributes where a matching field exists and the agentroute.* namespace for
// routing-specific data. It never exports task descriptions, prompts,
// endpoints, or extensions.
import type { RouteState } from "./route-types.js";
import { policyViolations } from "./route.js";

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

type Attr = { key: string; value: Record<string, unknown> };
const text = (key: string, value: string): Attr => ({ key, value: { stringValue: value } });
const integer = (key: string, value: number): Attr => ({ key, value: { intValue: String(value) } });
const decimal = (key: string, value: number): Attr => ({ key, value: { doubleValue: value } });

export type TelemetryProfile = "otel-genai" | "openinference";

function profileAttributes(profile: TelemetryProfile, model: string, provider?: string): Attr[] {
  if (profile === "openinference") {
    return [
      text("openinference.span.kind", "LLM"),
      text("llm.model_name", model),
      ...(provider ? [text("llm.provider", provider)] : []),
    ];
  }
  return [
    text("gen_ai.operation.name", "select_model"),
    text("gen_ai.request.model", model),
    ...(provider ? [text("gen_ai.provider.name", provider)] : []),
  ];
}

/** Convert one folded route decision into a metadata-only OTLP/JSON export. */
export function routeToTelemetry(state: RouteState, profile: TelemetryProfile = "otel-genai"): Record<string, unknown> {
  const decision = state.decision;
  const selected = decision.candidates.find((candidate) => candidate.id === decision.selection.candidate_id)!;
  const traceId = (fnv1a(decision.route_id) + fnv1a(`route:${decision.route_id}`) + fnv1a(decision.router.name) + fnv1a("agentroute")).slice(0, 32).padEnd(32, "0");
  const spanId = (fnv1a(`span:${decision.route_id}`) + fnv1a(decision.route_id)).slice(0, 16).padEnd(16, "0");
  const started = BigInt(Date.parse(decision.created_at)) * 1_000_000n;
  const ended = state.latest_observation ? BigInt(Date.parse(state.latest_observation.observed_at)) * 1_000_000n : started + 1n;
  const violations = policyViolations(decision);
  const attrs: Attr[] = [
    ...profileAttributes(profile, selected.model, selected.provider),
    text("agentroute.route_id", decision.route_id),
    text("agentroute.router.name", decision.router.name),
    text("agentroute.task.type", decision.task.type),
    text("agentroute.source.kind", decision.source.kind),
    text("agentroute.source.fidelity", decision.source.fidelity),
    integer("agentroute.candidate.count", decision.candidates.length),
    integer("agentroute.policy.violation_count", violations.length),
  ];
  if (decision.router.policy_id) attrs.push(text("agentroute.policy.id", decision.router.policy_id));
  if (decision.selection.confidence !== undefined) attrs.push(decimal("agentroute.selection.confidence", decision.selection.confidence));
  const outcome = state.latest_observation?.outcome;
  if (outcome) {
    attrs.push(text("agentroute.outcome.status", outcome.status));
    if (outcome.latency_ms !== undefined) attrs.push(decimal("agentroute.outcome.latency_ms", outcome.latency_ms));
    if (outcome.cost_usd !== undefined) attrs.push(decimal("agentroute.outcome.cost_usd", outcome.cost_usd));
    if (outcome.quality !== undefined) attrs.push(decimal("agentroute.outcome.quality", outcome.quality));
  }
  return {
    resourceSpans: [{
      resource: { attributes: [text("service.name", "agentroute"), text("agentroute.route_id", decision.route_id)] },
      scopeSpans: [{
        scope: { name: "agentroute", version: "0.2.0" },
        spans: [{
          traceId,
          spanId,
          name: `select_model ${selected.model}`,
          kind: 1,
          startTimeUnixNano: String(started),
          endTimeUnixNano: String(ended),
          attributes: attrs,
          status: { code: outcome?.status === "failure" ? 2 : outcome ? 1 : 0 },
        }],
      }],
    }],
  };
}

/** Backward-compatible name for the OpenTelemetry GenAI profile. */
export function routeToOtel(state: RouteState): Record<string, unknown> {
  return routeToTelemetry(state, "otel-genai");
}
