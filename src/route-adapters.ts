// Metadata-only adapters for common routing surfaces. These intentionally
// degrade to selected-only evidence unless the caller explicitly attests that
// a supplied candidate list is complete.
import { createRouteDecision } from "./route.js";
import type { RouteCandidate, RouteDecision, RouteFidelity } from "./route-types.js";

export interface RouteImportOptions {
  routeId?: string;
  createdAt?: string;
  taskType?: string;
  taskDescription?: string;
  taskFingerprint?: string;
  reason?: string;
  completeCandidateSet?: boolean;
  routerName?: string;
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (...values: unknown[]): string | undefined => values.find((value) => typeof value === "string" && value.length > 0) as string | undefined;
const number = (...values: unknown[]): number | undefined => values.find((value) => typeof value === "number" && Number.isFinite(value)) as number | undefined;

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
