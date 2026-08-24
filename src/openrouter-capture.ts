import { fromOpenRouterRoute } from "./route-adapters.js";
import { createRouteObservation, fingerprintTask } from "./route.js";
import type { RouteDecision, RouteObservation } from "./route-types.js";

interface FetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<FetchResponse>;

export interface OpenRouterCaptureOptions {
  apiKey: string;
  request: Record<string, unknown>;
  routeId?: string;
  taskType?: string;
  taskFingerprint?: string;
  endpoint?: string;
  fetcher?: FetchLike;
  clock?: () => number;
}

export interface OpenRouterCaptureResult {
  decision: RouteDecision;
  observation: RouteObservation;
  response: Record<string, unknown>;
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const number = (...values: unknown[]): number | undefined =>
  values.find((value) => typeof value === "number" && Number.isFinite(value) && value >= 0) as number | undefined;
const string = (...values: unknown[]): string | undefined =>
  values.find((value) => typeof value === "string" && value.length > 0) as string | undefined;

function safeError(body: Record<string, unknown>, status: number): Error {
  const error = object(body.error);
  const message = string(error.message, body.message) || "request failed";
  return new Error(`OpenRouter request failed (${status}): ${message.slice(0, 500)}`);
}

/**
 * Execute one non-streaming OpenRouter request and return an append-ready
 * decision/observation pair. Request messages and response text are never
 * copied into either record.
 */
export async function captureOpenRouter(options: OpenRouterCaptureOptions): Promise<OpenRouterCaptureResult> {
  if (!options.apiKey) throw new Error("OPENROUTER_API_KEY is required for live capture");
  if (options.request.stream === true) throw new Error("live capture currently requires a non-streaming OpenRouter request");
  const requestedModel = string(options.request.model);
  if (!requestedModel) throw new Error("OpenRouter capture request requires `model`");
  if (!Array.isArray(options.request.messages) || !options.request.messages.length) {
    throw new Error("OpenRouter capture request requires non-empty `messages`");
  }

  const clock = options.clock || Date.now;
  const started = clock();
  const fetcher = options.fetcher || fetch;
  const response = await fetcher(options.endpoint || "https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
      "X-OpenRouter-Metadata": "enabled",
    },
    body: JSON.stringify(options.request),
  });
  const finished = clock();
  let payload: Record<string, unknown>;
  try {
    payload = object(JSON.parse(await response.text()));
  } catch {
    throw new Error(`OpenRouter returned malformed JSON (${response.status})`);
  }
  if (!response.ok) throw safeError(payload, response.status);

  const decision = fromOpenRouterRoute(payload, {
    ...(options.routeId ? { routeId: options.routeId } : {}),
    createdAt: new Date(started).toISOString(),
    taskType: options.taskType || "llm_inference",
    taskFingerprint: options.taskFingerprint || fingerprintTask({
      model: options.request.model,
      messages: options.request.messages,
      tools: options.request.tools,
    }),
  });
  const selected = decision.candidates.find((candidate) => candidate.id === decision.selection.candidate_id)!;
  const usage = object(payload.usage);
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const usedTools = choices.some((choice) => Array.isArray(object(object(choice).message).tool_calls));
  const tokenUsage = {
    ...(number(usage.prompt_tokens) !== undefined ? { prompt_tokens: number(usage.prompt_tokens) } : {}),
    ...(number(usage.completion_tokens) !== undefined ? { completion_tokens: number(usage.completion_tokens) } : {}),
    ...(number(usage.total_tokens) !== undefined ? { total_tokens: number(usage.total_tokens) } : {}),
  };
  const observation = createRouteObservation({
    route_id: decision.route_id,
    observed_at: new Date(finished).toISOString(),
    outcome: {
      status: "success",
      actual_model: string(payload.model) || selected.model,
      ...(selected.provider ? { actual_provider: selected.provider } : {}),
      latency_ms: Math.max(0, finished - started),
      ...(number(usage.cost, payload.total_cost) !== undefined ? { cost_usd: number(usage.cost, payload.total_cost) } : {}),
      metadata: {
        tool_calls: usedTools ? "present" : "none",
        ...(Object.keys(tokenUsage).length ? { token_usage: tokenUsage } : {}),
      },
    },
  });
  return { decision, observation, response: payload };
}
