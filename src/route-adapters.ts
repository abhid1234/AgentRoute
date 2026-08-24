// Metadata-only adapters for common routing surfaces. These intentionally
// degrade to selected-only evidence unless the caller explicitly attests that
// a supplied candidate list is complete.
import { createHash } from "node:crypto";
import { createRouteDecision, createRouteObservation } from "./route.js";
import type { RouteCandidate, RouteDecision, RouteFidelity, RouteObservation, RouteOutcomeStatus } from "./route-types.js";

export interface RouteImportOptions {
  routeId?: string;
  createdAt?: string;
  taskType?: string;
  taskDescription?: string;
  taskFingerprint?: string;
  reason?: string;
  completeCandidateSet?: boolean;
  routerName?: string;
  portkeyCostUnit?: "usd" | "cents";
}

export interface GatewayRouteImport {
  decision: RouteDecision;
  observation?: RouteObservation;
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (...values: unknown[]): string | undefined => values.find((value) => typeof value === "string" && value.length > 0) as string | undefined;
const number = (...values: unknown[]): number | undefined => {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
};
const boolean = (...values: unknown[]): boolean | undefined => values.find((value) => typeof value === "boolean") as boolean | undefined;

function list(...values: unknown[]): string[] {
  for (const value of values) {
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.length > 0);
  }
  return [];
}

function header(headers: unknown, name: string): string | undefined {
  const values = object(headers);
  const match = Object.entries(values).find(([key, value]) => key.toLowerCase() === name && typeof value === "string");
  return match?.[1] as string | undefined;
}

function timestamp(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
    if (typeof value === "number" && Number.isFinite(value)) {
      const date = new Date(value < 10_000_000_000 ? value * 1000 : value);
      if (!Number.isNaN(date.valueOf())) return date.toISOString();
    }
  }
  return undefined;
}

function stableId(prefix: "route" | "obs", source: string, eventId: string | undefined): string | undefined {
  if (!eventId) return undefined;
  const digest = createHash("sha256").update(`${source}\u0000${eventId}`).digest("hex").slice(0, 24);
  return `${prefix}_${source.replace(/[^a-z0-9]+/gi, "_")}_${digest}`;
}

function openRouterCandidates(metadata: Record<string, unknown>): RouteCandidate[] {
  const endpoints = object(metadata.endpoints);
  if (!Array.isArray(endpoints.available)) return [];
  return endpoints.available.flatMap((item, index) => {
    const endpoint = object(item);
    const model = string(endpoint.model);
    if (!model) return [];
    const provider = string(endpoint.provider);
    return [{
      id: `endpoint_${index + 1}`,
      model,
      ...(provider ? { provider } : {}),
      ...(typeof endpoint.selected === "boolean" ? { eligible: true } : {}),
    }];
  });
}

function safeOpenRouterMetadata(metadata: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!Object.keys(metadata).length) return undefined;
  const attempts = Array.isArray(metadata.attempts) ? metadata.attempts.flatMap((item) => {
    const attempt = object(item);
    const provider = string(attempt.provider);
    const model = string(attempt.model);
    const status = number(attempt.status);
    if (!provider && !model && status === undefined) return [];
    return [{
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      ...(status !== undefined ? { status } : {}),
    }];
  }) : [];
  const pipeline = Array.isArray(metadata.pipeline) ? metadata.pipeline.flatMap((item) => {
    const stage = object(item);
    const type = string(stage.type);
    const name = string(stage.name);
    const summary = string(stage.summary);
    if (!type && !name && !summary) return [];
    return [{
      ...(type ? { type } : {}),
      ...(name ? { name } : {}),
      ...(summary ? { summary } : {}),
    }];
  }) : [];
  return {
    ...(string(metadata.requested) ? { requested: string(metadata.requested) } : {}),
    ...(string(metadata.strategy) ? { strategy: string(metadata.strategy) } : {}),
    ...(string(metadata.region) ? { region: string(metadata.region) } : {}),
    ...(number(metadata.attempt) !== undefined ? { attempt: number(metadata.attempt) } : {}),
    ...(typeof metadata.is_byok === "boolean" ? { is_byok: metadata.is_byok } : {}),
    ...(attempts.length ? { attempts } : {}),
    ...(pipeline.length ? { pipeline } : {}),
  };
}

function candidatesFrom(value: unknown): RouteCandidate[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    const candidate = object(item);
    const model = string(candidate.model, candidate.model_id, candidate.name);
    if (!model) return [];
    const estimates = object(candidate.estimates);
    const scores = object(candidate.scores);
    return [{
      id: string(candidate.id) || `candidate_${index + 1}`,
      model,
      ...(string(candidate.provider, candidate.provider_name) ? { provider: string(candidate.provider, candidate.provider_name) } : {}),
      ...(typeof candidate.eligible === "boolean" ? { eligible: candidate.eligible } : {}),
      ...(number(estimates.quality, candidate.quality) !== undefined || number(estimates.latency_ms, candidate.latency_ms) !== undefined || number(estimates.cost_usd, candidate.cost_usd) !== undefined ? {
        estimates: {
          ...(number(estimates.quality, candidate.quality) !== undefined ? { quality: number(estimates.quality, candidate.quality) } : {}),
          ...(number(estimates.latency_ms, candidate.latency_ms) !== undefined ? { latency_ms: number(estimates.latency_ms, candidate.latency_ms) } : {}),
          ...(number(estimates.cost_usd, candidate.cost_usd) !== undefined ? { cost_usd: number(estimates.cost_usd, candidate.cost_usd) } : {}),
        },
      } : {}),
      ...(number(scores.overall, candidate.score) !== undefined ? { scores: { overall: number(scores.overall, candidate.score) } } : {}),
    } as RouteCandidate];
  });
}

function withSelected(candidates: RouteCandidate[], selected: RouteCandidate): RouteCandidate[] {
  const match = candidates.find((candidate) => candidate.id === selected.id ||
    (candidate.model === selected.model && candidate.provider === selected.provider));
  return match ? candidates : [selected, ...candidates];
}

function candidatesWithFallbacks(selected: RouteCandidate, supplied: unknown, fallbacks: string[]): RouteCandidate[] {
  const candidates = candidatesFrom(supplied);
  for (const [index, model] of fallbacks.entries()) {
    if (!candidates.some((candidate) => candidate.model === model)) {
      candidates.push({ id: `fallback_${index + 1}`, model });
    }
  }
  return withSelected(candidates, selected);
}

function fidelity(candidates: RouteCandidate[], complete: boolean | undefined): RouteFidelity {
  if (complete) return "full";
  return candidates.length > 1 ? "partial" : "selected-only";
}

function base(options: RouteImportOptions): Pick<RouteDecision, "task"> & { route_id?: string; created_at?: string } {
  return {
    ...(options.routeId ? { route_id: options.routeId } : {}),
    ...(options.createdAt ? { created_at: options.createdAt } : {}),
    task: {
      type: options.taskType || "llm_inference",
      ...(options.taskDescription ? { description: options.taskDescription } : {}),
      ...(options.taskFingerprint ? { fingerprint: options.taskFingerprint } : {}),
    },
  };
}

/** Import metadata from an OpenRouter response/generation envelope. */
export function fromOpenRouterRoute(event: unknown, options: RouteImportOptions = {}): RouteDecision {
  const value = object(event);
  const data = object(value.data);
  const metadata = object(value.openrouter_metadata ?? data.openrouter_metadata);
  const selectedModel = string(value.model, data.model);
  if (!selectedModel) throw new Error("OpenRouter import requires a selected `model`");
  const endpointItems = Array.isArray(object(metadata.endpoints).available) ? object(metadata.endpoints).available as unknown[] : [];
  const selectedEndpoint = object(endpointItems.find((item) => object(item).selected === true));
  const selectedProvider = string(selectedEndpoint.provider, value.provider_name, value.provider, data.provider_name, data.provider);
  const selectedId = string(value.selected_candidate_id, data.selected_candidate_id) || "selected";
  const selected: RouteCandidate = {
    id: selectedId,
    model: selectedModel,
    ...(selectedProvider ? { provider: selectedProvider } : {}),
  };
  const metadataCandidates = openRouterCandidates(metadata);
  const supplied = metadataCandidates.length ? metadataCandidates : candidatesFrom(value.candidates ?? data.candidates);
  const candidates = withSelected(supplied, selected);
  const selectedCandidate = candidates.find((candidate) =>
    candidate.model === selectedModel && (!selectedProvider || candidate.provider === selectedProvider),
  ) || candidates.find((candidate) => candidate.id === selectedId) || candidates[0];
  const endpoints = object(metadata.endpoints);
  const endpointTotal = number(endpoints.total);
  const metadataIsComplete = metadataCandidates.length > 0 && endpointTotal === metadataCandidates.length;
  const safeMetadata = safeOpenRouterMetadata(metadata);
  return createRouteDecision({
    ...base(options),
    router: {
      name: options.routerName || "openrouter",
      ...(string(metadata.strategy) ? { policy_id: string(metadata.strategy) } : {}),
    },
    source: {
      kind: "openrouter",
      fidelity: fidelity(candidates, options.completeCandidateSet || metadataIsComplete),
      ...(string(value.id, data.id) ? { event_id: string(value.id, data.id) } : {}),
    },
    candidates,
    selection: {
      candidate_id: selectedCandidate.id,
      reason: options.reason || string(metadata.summary) || "Selected by OpenRouter; upstream rationale was not exposed",
    },
    ...(safeMetadata ? { extensions: { openrouter: safeMetadata } } : {}),
  });
}

/** Import metadata from a LiteLLM callback/logging envelope. */
export function fromLiteLLMRoute(event: unknown, options: RouteImportOptions = {}): RouteDecision {
  const value = object(event);
  const params = object(value.litellm_params);
  const response = object(value.response);
  const selectedModel = string(value.model, params.model, response.model);
  if (!selectedModel) throw new Error("LiteLLM import requires a selected `model`");
  const selectedProvider = string(value.custom_llm_provider, params.custom_llm_provider, value.provider);
  const selectedId = string(value.selected_candidate_id) || "selected";
  const selected: RouteCandidate = {
    id: selectedId,
    model: selectedModel,
    ...(selectedProvider ? { provider: selectedProvider } : {}),
  };
  const supplied = candidatesFrom(value.candidates ?? params.candidates);
  const candidates = withSelected(supplied, selected);
  return createRouteDecision({
    ...base(options),
    router: { name: options.routerName || "litellm" },
    source: { kind: "litellm", fidelity: fidelity(candidates, options.completeCandidateSet), ...(string(value.call_id, value.id) ? { event_id: string(value.call_id, value.id) } : {}) },
    candidates,
    selection: {
      candidate_id: (candidates.find((candidate) => candidate.id === selectedId) || candidates.find((candidate) => candidate.model === selectedModel && candidate.provider === selectedProvider) || candidates[0]).id,
      reason: options.reason || "Selected by LiteLLM; upstream rationale was not exposed",
    },
  });
}

/** Import an allowlisted subset of a Portkey log or response envelope. */
export function fromPortkeyRoute(event: unknown, options: RouteImportOptions = {}): RouteDecision {
  const value = object(event);
  const response = object(value.response);
  const request = object(value.request);
  const eventId = string(value.trace_id, value.id, header(value.headers, "x-portkey-trace-id"), header(response.headers, "x-portkey-trace-id"));
  const selectedModel = string(value.ai_model, value.model, response.model, request.model);
  if (!selectedModel) throw new Error("Portkey import requires a selected `model` or `ai_model`");
  const selectedProvider = string(value.provider, value.ai_org, value.provider_name);
  const selectedId = string(value.selected_candidate_id) || "selected";
  const selected: RouteCandidate = { id: selectedId, model: selectedModel, ...(selectedProvider ? { provider: selectedProvider } : {}) };
  const fallbacks = list(value.fallback_models, object(value.routing).fallback_models);
  const candidates = candidatesWithFallbacks(selected, value.candidates, fallbacks);
  const retryCount = number(value.retry_count, value.retry_success_count, header(value.headers, "x-portkey-retry-count"));
  const cacheStatus = string(value.cache_status, header(value.headers, "x-portkey-cache-status"));
  const optionIndex = number(value.option_index, header(value.headers, "x-portkey-last-used-option-index"));
  return createRouteDecision({
    ...base(options),
    ...(options.routeId || stableId("route", "portkey", eventId) ? { route_id: options.routeId || stableId("route", "portkey", eventId) } : {}),
    ...(options.createdAt || timestamp(value.created_at, value.timestamp) ? { created_at: options.createdAt || timestamp(value.created_at, value.timestamp) } : {}),
    router: { name: options.routerName || "portkey", ...(string(value.config_id) ? { policy_id: string(value.config_id) } : {}) },
    source: { kind: "portkey", fidelity: fidelity(candidates, options.completeCandidateSet), ...(eventId ? { event_id: eventId } : {}) },
    candidates,
    selection: {
      candidate_id: (candidates.find((candidate) => candidate.id === selectedId) || candidates[0]).id,
      reason: options.reason || "Selected by Portkey; only allowlisted gateway metadata was imported",
      ...(fallbacks.length ? { fallback_order: candidates.filter((candidate) => fallbacks.includes(candidate.model)).map((candidate) => candidate.id) } : {}),
    },
    ...((retryCount !== undefined || cacheStatus || optionIndex !== undefined || string(value.mode)) ? {
      extensions: { portkey: {
        ...(retryCount !== undefined ? { retry_count: retryCount } : {}),
        ...(cacheStatus ? { cache_status: cacheStatus } : {}),
        ...(optionIndex !== undefined ? { option_index: optionIndex } : {}),
        ...(string(value.mode) ? { mode: string(value.mode) } : {}),
      } },
    } : {}),
  });
}

/** Import provider selection metadata from a Vercel AI Gateway log/response. */
export function fromVercelAiGatewayRoute(event: unknown, options: RouteImportOptions = {}): RouteDecision {
  const value = object(event);
  const response = object(value.response);
  const data = object(value.data);
  const routing = object(value.routing ?? value.providerOptions ?? value.provider_options);
  const providerMetadata = object(value.providerMetadata ?? value.provider_metadata ?? response.providerMetadata);
  const gateway = object(providerMetadata.gateway ?? providerMetadata.vercel ?? value.gateway);
  const eventId = string(value.request_id, value.requestId, value.id, gateway.request_id, gateway.requestId);
  const selectedModel = string(value.model, response.model, data.model, gateway.model);
  if (!selectedModel) throw new Error("Vercel AI Gateway import requires a selected `model`");
  const selectedProvider = string(value.provider, value.provider_name, value.providerName, gateway.provider, gateway.provider_name);
  const selectedId = string(value.selected_candidate_id) || "selected";
  const selected: RouteCandidate = { id: selectedId, model: selectedModel, ...(selectedProvider ? { provider: selectedProvider } : {}) };
  const fallbacks = list(value.fallback_models, value.models, routing.models, routing.fallback_models);
  const candidates = candidatesWithFallbacks(selected, value.candidates, fallbacks);
  const providerOrder = list(routing.order, value.provider_order);
  const providerOnly = list(routing.only, value.provider_only);
  return createRouteDecision({
    ...base(options),
    ...(options.routeId || stableId("route", "vercel_ai_gateway", eventId) ? { route_id: options.routeId || stableId("route", "vercel_ai_gateway", eventId) } : {}),
    ...(options.createdAt || timestamp(value.created_at, value.timestamp) ? { created_at: options.createdAt || timestamp(value.created_at, value.timestamp) } : {}),
    router: { name: options.routerName || "vercel-ai-gateway" },
    source: { kind: "vercel-ai-gateway", fidelity: fidelity(candidates, options.completeCandidateSet), ...(eventId ? { event_id: eventId } : {}) },
    candidates,
    selection: {
      candidate_id: (candidates.find((candidate) => candidate.id === selectedId) || candidates[0]).id,
      reason: options.reason || "Selected by Vercel AI Gateway; only allowlisted provider metadata was imported",
      ...(fallbacks.length ? { fallback_order: candidates.filter((candidate) => fallbacks.includes(candidate.model)).map((candidate) => candidate.id) } : {}),
    },
    ...((providerOrder.length || providerOnly.length) ? { extensions: { vercel_ai_gateway: {
      ...(providerOrder.length ? { provider_order: providerOrder } : {}),
      ...(providerOnly.length ? { provider_only: providerOnly } : {}),
    } } } : {}),
  });
}

/** Import the documented metadata fields from a Cloudflare AI Gateway log. */
export function fromCloudflareAiGatewayRoute(event: unknown, options: RouteImportOptions = {}): RouteDecision {
  const value = object(event);
  const eventId = string(value.id, value.request_id);
  const selectedModel = string(value.model);
  if (!selectedModel) throw new Error("Cloudflare AI Gateway import requires a selected `model`");
  const selectedProvider = string(value.provider);
  const selected: RouteCandidate = { id: "selected", model: selectedModel, ...(selectedProvider ? { provider: selectedProvider } : {}) };
  const candidates = withSelected(candidatesFrom(value.candidates), selected);
  return createRouteDecision({
    ...base(options),
    ...(options.routeId || stableId("route", "cloudflare_ai_gateway", eventId) ? { route_id: options.routeId || stableId("route", "cloudflare_ai_gateway", eventId) } : {}),
    ...(options.createdAt || timestamp(value.created_at) ? { created_at: options.createdAt || timestamp(value.created_at) } : {}),
    router: { name: options.routerName || "cloudflare-ai-gateway" },
    source: { kind: "cloudflare-ai-gateway", fidelity: fidelity(candidates, options.completeCandidateSet), ...(eventId ? { event_id: eventId } : {}) },
    candidates,
    selection: { candidate_id: (candidates.find((candidate) => candidate.id === "selected") || candidates.find((candidate) => candidate.model === selectedModel && candidate.provider === selectedProvider) || candidates[0]).id, reason: options.reason || "Selected by Cloudflare AI Gateway; only documented log metadata was imported" },
  });
}

function status(success: boolean | undefined, statusCode: number | undefined): RouteOutcomeStatus {
  if (success === true || (statusCode !== undefined && statusCode >= 200 && statusCode < 400)) return "success";
  if (success === false || (statusCode !== undefined && statusCode >= 400)) return "failure";
  return "unknown";
}

function gatewayObservation(source: "portkey" | "vercel_ai_gateway" | "cloudflare_ai_gateway", event: Record<string, unknown>, decision: RouteDecision, portkeyCostUnit?: "usd" | "cents"): RouteObservation | undefined {
  const response = object(event.response);
  const eventId = decision.source.event_id;
  const statusCode = number(event.status_code, event.status, response.status, response.status_code);
  const succeeded = boolean(event.success, response.success);
  const latency = number(event.duration, event.response_time, event.latency_ms, response.latency_ms);
  const directCost = number(event.cost_usd, response.cost_usd);
  const portkeyCost = source === "portkey" && portkeyCostUnit ? number(event.cost) : undefined;
  const cost = directCost ?? (portkeyCost !== undefined ? portkeyCostUnit === "cents" ? portkeyCost / 100 : portkeyCost : undefined);
  const observedAt = timestamp(event.observed_at, event.created_at, event.timestamp) || decision.created_at;
  const tokensIn = number(event.tokens_in, event.input_tokens);
  const tokensOut = number(event.tokens_out, event.output_tokens);
  const cached = boolean(event.cached);
  const retryCount = number(event.retry_count, event.retry_success_count);
  if (statusCode === undefined && succeeded === undefined && latency === undefined && cost === undefined && tokensIn === undefined && tokensOut === undefined && cached === undefined && retryCount === undefined) return undefined;
  return createRouteObservation({
    route_id: decision.route_id,
    ...(stableId("obs", source, eventId) ? { observation_id: stableId("obs", source, eventId) } : {}),
    observed_at: observedAt,
    outcome: {
      status: status(succeeded, statusCode),
      actual_model: decision.candidates.find((candidate) => candidate.id === decision.selection.candidate_id)!.model,
      ...(decision.candidates.find((candidate) => candidate.id === decision.selection.candidate_id)!.provider ? { actual_provider: decision.candidates.find((candidate) => candidate.id === decision.selection.candidate_id)!.provider } : {}),
      ...(latency !== undefined && latency >= 0 ? { latency_ms: latency } : {}),
      ...(cost !== undefined && cost >= 0 ? { cost_usd: cost } : {}),
      ...((statusCode !== undefined || tokensIn !== undefined || tokensOut !== undefined || cached !== undefined || retryCount !== undefined) ? { metadata: {
        ...(statusCode !== undefined ? { status_code: statusCode } : {}),
        ...(tokensIn !== undefined ? { tokens_in: tokensIn } : {}),
        ...(tokensOut !== undefined ? { tokens_out: tokensOut } : {}),
        ...(cached !== undefined ? { cached } : {}),
        ...(retryCount !== undefined ? { retry_count: retryCount } : {}),
      } } : {}),
    },
    extensions: { imported_from: source.replaceAll("_", "-") },
  });
}

export function importPortkeyRoute(event: unknown, options: RouteImportOptions = {}): GatewayRouteImport {
  const decision = fromPortkeyRoute(event, options);
  const observation = gatewayObservation("portkey", object(event), decision, options.portkeyCostUnit);
  return { decision, ...(observation ? { observation } : {}) };
}

export function importVercelAiGatewayRoute(event: unknown, options: RouteImportOptions = {}): GatewayRouteImport {
  const decision = fromVercelAiGatewayRoute(event, options);
  const observation = gatewayObservation("vercel_ai_gateway", object(event), decision);
  return { decision, ...(observation ? { observation } : {}) };
}

export function importCloudflareAiGatewayRoute(event: unknown, options: RouteImportOptions = {}): GatewayRouteImport {
  const decision = fromCloudflareAiGatewayRoute(event, options);
  const observation = gatewayObservation("cloudflare_ai_gateway", object(event), decision);
  return { decision, ...(observation ? { observation } : {}) };
}
