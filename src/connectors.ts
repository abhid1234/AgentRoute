export type ConnectorStatus = "available" | "planned";
export type ConnectorDirection = "inbound" | "outbound" | "bidirectional";
export type ConnectorRole =
  | "router"
  | "gateway"
  | "task-source"
  | "telemetry"
  | "evaluator"
  | "policy-target";

export type ConnectorCapability =
  | "decision-import"
  | "live-capture"
  | "task-pack"
  | "trace-export"
  | "evaluation-import"
  | "policy-export";

export interface AgentRouteConnector {
  id: string;
  name: string;
  status: ConnectorStatus;
  direction: ConnectorDirection;
  roles: ConnectorRole[];
  capabilities: ConnectorCapability[];
  transport: string;
  summary: string;
  docs_url: string;
}

export interface ConnectorFilters {
  status?: ConnectorStatus;
  role?: ConnectorRole;
  capability?: ConnectorCapability;
}

export const CONNECTOR_STATUSES = ["available", "planned"] as const;
export const CONNECTOR_ROLES = ["router", "gateway", "task-source", "telemetry", "evaluator", "policy-target"] as const;
export const CONNECTOR_CAPABILITIES = ["decision-import", "live-capture", "task-pack", "trace-export", "evaluation-import", "policy-export"] as const;

export const isConnectorStatus = (value: string): value is ConnectorStatus =>
  (CONNECTOR_STATUSES as readonly string[]).includes(value);
export const isConnectorRole = (value: string): value is ConnectorRole =>
  (CONNECTOR_ROLES as readonly string[]).includes(value);
export const isConnectorCapability = (value: string): value is ConnectorCapability =>
  (CONNECTOR_CAPABILITIES as readonly string[]).includes(value);

/**
 * Product capability map, not a promise that every named system is integrated.
 * A connector is `available` only when this repository has a tested path for it.
 */
export const AGENTROUTE_CONNECTORS: readonly AgentRouteConnector[] = [
  {
    id: "native-receipt",
    name: "AgentRoute receipt API",
    status: "available",
    direction: "inbound",
    roles: ["router", "gateway"],
    capabilities: ["decision-import"],
    transport: "JSON / JSONL",
    summary: "Any application-native router can emit the versioned receipt contract directly.",
    docs_url: "./docs/agentroute-spec.md",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    status: "available",
    direction: "inbound",
    roles: ["router", "gateway"],
    capabilities: ["decision-import", "live-capture"],
    transport: "response metadata / API",
    summary: "Imports allowlisted routing metadata and supports explicit non-streaming capture.",
    docs_url: "https://openrouter.ai/docs",
  },
  {
    id: "litellm",
    name: "LiteLLM",
    status: "available",
    direction: "inbound",
    roles: ["router", "gateway"],
    capabilities: ["decision-import"],
    transport: "callback metadata",
    summary: "Normalizes selected model and provider metadata with conservative evidence fidelity.",
    docs_url: "https://docs.litellm.ai/",
  },
  {
    id: "exa",
    name: "Exa",
    status: "available",
    direction: "inbound",
    roles: ["task-source"],
    capabilities: ["task-pack"],
    transport: "search API",
    summary: "Builds fresh, source-linked evaluation task packs without granting routing authority.",
    docs_url: "https://docs.exa.ai/",
  },
  {
    id: "opentelemetry",
    name: "OpenTelemetry",
    status: "available",
    direction: "outbound",
    roles: ["telemetry"],
    capabilities: ["trace-export"],
    transport: "privacy-safe OTLP JSON",
    summary: "Exports routing-decision spans without prompts, response text, or candidate endpoints.",
    docs_url: "https://opentelemetry.io/docs/specs/semconv/",
  },
  {
    id: "portkey",
    name: "Portkey AI Gateway",
    status: "planned",
    direction: "bidirectional",
    roles: ["router", "gateway", "policy-target"],
    capabilities: ["decision-import", "policy-export"],
    transport: "gateway logs / config export",
    summary: "Candidate for retry, fallback, conditional-routing, and policy recommendation evidence.",
    docs_url: "https://portkey.ai/docs/product/ai-gateway",
  },
  {
    id: "vercel-ai-gateway",
    name: "Vercel AI Gateway",
    status: "planned",
    direction: "bidirectional",
    roles: ["router", "gateway", "policy-target"],
    capabilities: ["decision-import", "policy-export"],
    transport: "provider metadata / provider options",
    summary: "Candidate for provider-order, provider-filter, and fallback decision receipts.",
    docs_url: "https://vercel.com/docs/ai-gateway",
  },
  {
    id: "cloudflare-ai-gateway",
    name: "Cloudflare AI Gateway",
    status: "planned",
    direction: "inbound",
    roles: ["gateway", "telemetry"],
    capabilities: ["decision-import"],
    transport: "logs / analytics / OpenTelemetry",
    summary: "Candidate for retry, fallback, cache, cost, error, and latency observations.",
    docs_url: "https://developers.cloudflare.com/ai-gateway/",
  },
  {
    id: "braintrust",
    name: "Braintrust",
    status: "planned",
    direction: "inbound",
    roles: ["evaluator", "telemetry"],
    capabilities: ["evaluation-import"],
    transport: "experiment / trace results",
    summary: "Candidate for immutable experiment scores and production evaluation observations.",
    docs_url: "https://www.braintrust.dev/docs/evaluate",
  },
];

export function listConnectors(filters: ConnectorFilters = {}): AgentRouteConnector[] {
  return AGENTROUTE_CONNECTORS.filter((connector) =>
    (!filters.status || connector.status === filters.status) &&
    (!filters.role || connector.roles.includes(filters.role)) &&
    (!filters.capability || connector.capabilities.includes(filters.capability))
  ).map((connector) => ({ ...connector, roles: [...connector.roles], capabilities: [...connector.capabilities] }));
}

export function formatConnectorCatalog(connectors: readonly AgentRouteConnector[] = AGENTROUTE_CONNECTORS): string {
  const rows = connectors.map((connector) => {
    const state = connector.status === "available" ? "READY" : "PLANNED";
    return `${state.padEnd(7)}  ${connector.name.padEnd(24)}  ${connector.direction.padEnd(13)}  ${connector.capabilities.join(", ")}`;
  });
  return [
    "AGENTROUTE CONNECTOR MAP",
    "STATUS   CONNECTOR                 DIRECTION      CAPABILITIES",
    ...rows,
    "",
    "READY means a tested repository path exists. PLANNED is architecture, not an integration claim.",
  ].join("\n");
}
