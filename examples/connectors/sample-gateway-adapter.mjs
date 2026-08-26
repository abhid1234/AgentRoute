import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createRouteDecision,
  createRouteObservation,
  runConnectorConformance,
} from "../../dist/index.js";

const manifest = {
  id: "sample-saved-gateway",
  name: "Sample saved gateway event",
  status: "available",
  direction: "inbound",
  roles: ["gateway"],
  capabilities: ["decision-import", "observation-import"],
  transport: "saved event JSON",
  summary: "Example allowlist adapter for a hypothetical gateway export.",
  docs_url: "../../docs/connector-sdk.md",
};

function requiredText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value;
}

function candidate(value, label) {
  if (!value || typeof value !== "object") throw new Error(`${label} is required`);
  return {
    id: requiredText(value.id, `${label}.id`),
    model: requiredText(value.model, `${label}.model`),
    ...(typeof value.provider === "string" && value.provider ? { provider: value.provider } : {}),
  };
}

export const sampleGatewayAdapter = {
  manifest,
  importFixture(event) {
    if (!event || typeof event !== "object") throw new Error("saved gateway event must be an object");
    const eventId = requiredText(event.id, "event.id");
    if (!/^[A-Za-z0-9_-]+$/.test(eventId)) throw new Error("event.id contains unsupported characters");
    const selected = candidate(event.selected, "event.selected");
    const alternatives = Array.isArray(event.alternatives) ? event.alternatives.map((value, index) => candidate(value, `event.alternatives[${index}]`)) : [];
    const candidates = [selected, ...alternatives];
    if (new Set(candidates.map((value) => value.id)).size !== candidates.length) throw new Error("gateway candidates must have unique ids");
    const routeId = `route_sample_${eventId}`;
    const decision = createRouteDecision({
      route_id: routeId,
      created_at: requiredText(event.created_at, "event.created_at"),
      task: { type: requiredText(event.task_type, "event.task_type") },
      router: { name: "sample-saved-gateway" },
      source: { kind: "custom", fidelity: "full", event_id: eventId },
      candidates,
      selection: { candidate_id: selected.id, reason: "selected by saved gateway event" },
    });
    if (!event.outcome) return decision;
    const outcome = event.outcome;
    const observation = createRouteObservation({
      route_id: routeId,
      observation_id: `obs_sample_${eventId}`,
      observed_at: requiredText(event.completed_at, "event.completed_at"),
      outcome: {
        status: requiredText(outcome.status, "event.outcome.status"),
        ...(typeof outcome.latency_ms === "number" ? { latency_ms: outcome.latency_ms } : {}),
        ...(typeof outcome.cost_usd === "number" ? { cost_usd: outcome.cost_usd } : {}),
        ...(typeof outcome.quality === "number" ? { quality: outcome.quality } : {}),
      },
    });
    return [decision, observation];
  },
};

const fixturePath = process.argv[2] || fileURLToPath(new URL("./sample-gateway-event.json", import.meta.url));
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const result = await runConnectorConformance(sampleGatewayAdapter, [{
  name: "sample saved gateway event",
  fixture,
  forbidden_markers: [fixture.prompt, fixture.response, fixture.authorization],
}]);
console.log(JSON.stringify(result, null, 2));
if (!result.valid) process.exit(1);
