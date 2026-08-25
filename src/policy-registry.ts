import type { RouteCriteria, RouteSimulationPolicy } from "./route-types.js";
import { canonicalJson, sha256 } from "./canonical.js";

export type PolicyStatus = "draft" | "reviewed" | "approved" | "deprecated";
export type PolicyTarget = "native" | "openrouter" | "litellm" | "portkey" | "vercel-ai-gateway";

export interface PolicyModelTarget {
  model: string;
  provider?: string;
  weight?: number;
}

export interface AgentRoutePolicy extends RouteSimulationPolicy {
  policy_version: "0.1";
  version: string;
  status: PolicyStatus;
  description?: string;
  models?: PolicyModelTarget[];
  criteria?: RouteCriteria;
}

export interface PolicyRegistry {
  registry_version: "0.1";
  policies: AgentRoutePolicy[];
  events?: PolicyRegistryEvent[];
}

export interface PolicyRegistryEvent {
  event_version: "0.1";
  event_id: string;
  policy_id: string;
  policy_version: string;
  from_status?: PolicyStatus;
  to_status: PolicyStatus;
  actor: string;
  reason: string;
  occurred_at: string;
  human_attested?: true;
  policy_fingerprint: string;
}

export interface PolicyDiff {
  from: string;
  to: string;
  changed_fields: string[];
  breaking: boolean;
}

export interface CompiledPolicy {
  compiler_version: "0.1";
  target: PolicyTarget;
  dry_run: true;
  source: { policy_id: string; policy_version: string; fingerprint: string };
  documentation: string;
  config: Record<string, unknown>;
  caveats: string[];
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export function validatePolicy(value: unknown): AgentRoutePolicy {
  if (!object(value)) throw new Error("policy must be an object");
  if (value.policy_version !== "0.1") throw new Error("policy_version must equal 0.1");
  if (typeof value.id !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(value.id)) throw new Error("policy id must be a lowercase stable identifier");
  if (typeof value.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.version)) throw new Error("policy version must be semantic versioning");
  if (!["draft", "reviewed", "approved", "deprecated"].includes(String(value.status))) throw new Error("policy status must be draft, reviewed, approved, or deprecated");
  if (!object(value.weights)) throw new Error("policy weights are required");
  const allowedWeights = new Set(["quality", "latency", "cost", "capability"]);
  const entries = Object.entries(value.weights);
  if (!entries.length || entries.some(([key, weight]) => !allowedWeights.has(key) || typeof weight !== "number" || !Number.isFinite(weight) || weight < 0 || weight > 1)) throw new Error("policy weights must use known dimensions in the range 0..1");
  const sum = entries.reduce((total, [, weight]) => total + (weight as number), 0);
  if (Math.abs(sum - 1) > 1e-9) throw new Error("policy weights must sum to 1");
  if (value.criteria !== undefined) {
    if (!object(value.criteria)) throw new Error("policy criteria must be an object");
    for (const key of ["max_cost_usd", "max_latency_ms", "min_quality"] as const) {
      const metric = value.criteria[key];
      if (metric !== undefined && (typeof metric !== "number" || !Number.isFinite(metric) || metric < 0 || (key === "min_quality" && metric > 1))) throw new Error(`criteria.${key} is invalid`);
    }
    if (value.criteria.required_capabilities !== undefined && (!Array.isArray(value.criteria.required_capabilities) || value.criteria.required_capabilities.some((item) => typeof item !== "string" || !item))) throw new Error("criteria.required_capabilities must be non-empty strings");
  }
  if (value.models !== undefined) {
    if (!Array.isArray(value.models) || !value.models.length) throw new Error("policy models must be a non-empty array");
    const identities = new Set<string>();
    for (const model of value.models) {
      if (!object(model) || typeof model.model !== "string" || !model.model) throw new Error("every policy model requires model");
      const key = `${String(model.provider || "")}\u0000${model.model}`;
      if (identities.has(key)) throw new Error(`duplicate policy model: ${model.provider ? model.provider + "/" : ""}${model.model}`);
      identities.add(key);
      if (model.provider !== undefined && (typeof model.provider !== "string" || !model.provider)) throw new Error("policy model provider must be a non-empty string");
      if (model.weight !== undefined && (typeof model.weight !== "number" || !Number.isFinite(model.weight) || model.weight <= 0)) throw new Error("policy model weight must be positive");
    }
  }
  return value as unknown as AgentRoutePolicy;
}

export function validatePolicyRegistry(value: unknown): PolicyRegistry {
  if (!object(value) || value.registry_version !== "0.1" || !Array.isArray(value.policies)) throw new Error("registry requires registry_version 0.1 and policies array");
  const policies = value.policies.map(validatePolicy);
  const identities = new Set<string>();
  for (const policy of policies) {
    const key = `${policy.id}@${policy.version}`;
    if (identities.has(key)) throw new Error(`duplicate registry policy: ${key}`);
    identities.add(key);
  }
  if (value.events !== undefined) {
    if (!Array.isArray(value.events)) throw new Error("registry events must be an array");
    const eventIds = new Set<string>();
    const known = new Set(policies.map((policy) => `${policy.id}@${policy.version}`));
    for (const raw of value.events) {
      if (!object(raw) || raw.event_version !== "0.1") throw new Error("registry event_version must equal 0.1");
      if (typeof raw.event_id !== "string" || !raw.event_id || eventIds.has(raw.event_id)) throw new Error(`registry event_id must be unique: ${String(raw.event_id || "<empty>")}`);
      eventIds.add(raw.event_id);
      if (typeof raw.policy_id !== "string" || typeof raw.policy_version !== "string" || !known.has(`${raw.policy_id}@${raw.policy_version}`)) throw new Error("registry event references an unknown policy");
      if (raw.from_status !== undefined && !["draft", "reviewed", "approved", "deprecated"].includes(String(raw.from_status))) throw new Error("registry event from_status is invalid");
      if (!["draft", "reviewed", "approved", "deprecated"].includes(String(raw.to_status))) throw new Error("registry event to_status is invalid");
      if (typeof raw.actor !== "string" || !raw.actor.trim() || typeof raw.reason !== "string" || !raw.reason.trim()) throw new Error("registry event requires actor and reason");
      if (typeof raw.occurred_at !== "string" || Number.isNaN(Date.parse(raw.occurred_at))) throw new Error("registry event occurred_at must be RFC3339");
      if (typeof raw.policy_fingerprint !== "string" || !/^sha256:[0-9a-f]{64}$/.test(raw.policy_fingerprint)) throw new Error("registry event policy_fingerprint is invalid");
      if (raw.human_attested !== undefined && raw.human_attested !== true) throw new Error("registry event human_attested may only be true");
    }
  }
  return value as unknown as PolicyRegistry;
}

function flatten(value: unknown, prefix = ""): Map<string, string> {
  const result = new Map<string, string>();
  if (object(value)) for (const key of Object.keys(value).sort()) for (const [path, item] of flatten(value[key], prefix ? `${prefix}.${key}` : key)) result.set(path, item);
  else result.set(prefix, canonicalJson(value));
  return result;
}

export function diffPolicies(fromValue: unknown, toValue: unknown): PolicyDiff {
  const from = validatePolicy(fromValue);
  const to = validatePolicy(toValue);
  if (from.id !== to.id) throw new Error("cannot diff policies with different IDs");
  const left = flatten(from);
  const right = flatten(to);
  const changed = [...new Set([...left.keys(), ...right.keys()])].filter((key) => left.get(key) !== right.get(key)).sort();
  return {
    from: `${from.id}@${from.version}`,
    to: `${to.id}@${to.version}`,
    changed_fields: changed,
    breaking: changed.some((key) => key.startsWith("criteria.") || key.startsWith("models") || key === "status" && to.status === "deprecated"),
  };
}

function qualifiedModel(model: PolicyModelTarget): string {
  return model.provider && !model.model.startsWith(`${model.provider}/`) ? `${model.provider}/${model.model}` : model.model;
}

function modelNames(policy: AgentRoutePolicy): string[] {
  return (policy.models || []).map(qualifiedModel);
}

function providers(policy: AgentRoutePolicy): string[] {
  return [...new Set((policy.models || []).flatMap((model) => model.provider ? [model.provider] : []))];
}

export function compilePolicy(value: unknown, target: PolicyTarget): CompiledPolicy {
  const policy = validatePolicy(value);
  if (!["native", "openrouter", "litellm", "portkey", "vercel-ai-gateway"].includes(target)) throw new Error(`unsupported policy target: ${target}`);
  const source = { policy_id: policy.id, policy_version: policy.version, fingerprint: sha256(policy) };
  const names = modelNames(policy);
  const order = providers(policy);
  const base = { compiler_version: "0.1" as const, target, dry_run: true as const, source };
  if (target === "native") return { ...base, documentation: "docs/evidence-suite-spec.md", config: { policy }, caveats: [] };
  if (!names.length) throw new Error(`${target} compilation requires policy.models`);
  if (target === "openrouter") return {
    ...base,
    documentation: "https://openrouter.ai/docs/guides/routing/provider-selection",
    config: { models: names, provider: { ...(order.length ? { order } : {}), allow_fallbacks: names.length > 1, ...(policy.criteria?.max_latency_ms !== undefined ? { preferred_max_latency: policy.criteria.max_latency_ms / 1000 } : {}) } },
    caveats: ["OpenRouter provider preferences rank endpoints; latency preferences are not hard guarantees.", "Review exact provider slugs before applying."],
  };
  if (target === "litellm") return {
    ...base,
    documentation: "https://docs.litellm.ai/docs/proxy/load_balancing",
    config: { model_list: (policy.models || []).map((model, index) => ({ model_name: policy.id, litellm_params: { model: qualifiedModel(model), order: index + 1 } })), router_settings: { routing_strategy: (policy.weights.latency || 0) > Math.max(policy.weights.quality || 0, policy.weights.cost || 0, policy.weights.capability || 0) ? "latency-based-routing" : (policy.weights.cost || 0) > Math.max(policy.weights.quality || 0, policy.weights.latency || 0, policy.weights.capability || 0) ? "cost-based-routing" : "simple-shuffle" } },
    caveats: ["Credential references and provider-specific deployment parameters must be added during human review.", "The generated routing strategy is an approximation of multi-dimensional AgentRoute weights."],
  };
  if (target === "portkey") return {
    ...base,
    documentation: "https://docs.portkey.ai/docs/product/ai-gateway/configs",
    config: { strategy: { mode: names.length > 1 ? "fallback" : "single", targets: (policy.models || []).map((model) => ({ model: model.model, ...(model.provider ? { provider: model.provider } : {}), ...(model.weight ? { weight: model.weight } : {}) })) } },
    caveats: ["This is a review artifact, not a Portkey API payload.", "Map provider names to workspace integrations before applying."],
  };
  return {
    ...base,
    documentation: "https://vercel.com/docs/ai-gateway/models-and-providers/provider-options",
    config: { model: names[0], providerOptions: { gateway: { ...(names.length > 1 ? { models: names.slice(1) } : {}), ...(order.length ? { order, only: order } : {}) } } },
    caveats: ["Use the config inside an AI SDK generation call after human review.", "Provider order applies independently to each fallback model."],
  };
}
