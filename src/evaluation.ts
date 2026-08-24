import { createHash } from "node:crypto";
import { createRouteObservation } from "./route.js";
import type { RouteObservation, RouteOutcome, RouteOutcomeStatus } from "./route-types.js";

export interface EvaluationCheck {
  id: string;
  passed: boolean;
  score?: number;
  weight?: number;
  required?: boolean;
  note?: string;
}

export interface BraintrustEvaluationOptions {
  routeId?: string;
  evaluatorId?: string;
  evaluatorVersion?: string;
  passThreshold?: number;
}

export interface EvaluationDraft {
  route_id: string;
  observation_id?: string;
  evaluator: { id: string; version?: string };
  checks: EvaluationCheck[];
  evaluated_at?: string;
  actual_model?: string;
  actual_provider?: string;
  latency_ms?: number;
  cost_usd?: number;
  trajectory_ref?: string;
}

export interface EvaluationResult {
  evaluation_version: "0.1";
  route_id: string;
  evaluated_at: string;
  evaluator: { id: string; version?: string };
  status: RouteOutcomeStatus;
  quality: number;
  checks: EvaluationCheck[];
}

function validateMetric(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new Error(`${name} must be >= 0`);
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (...values: unknown[]): string | undefined =>
  values.find((value) => typeof value === "string" && value.length > 0) as string | undefined;

const stableBraintrustObservationId = (externalId: string): string =>
  `obs_braintrust_${createHash("sha256").update(externalId).digest("hex").slice(0, 24)}`;

/**
 * Convert Braintrust experiment/span scores into the neutral evaluator draft.
 * Inputs, outputs, prompts, metadata, and evaluator reasoning are intentionally
 * not retained. Numeric scores are expected on Braintrust's 0..1 scale.
 */
export function fromBraintrustEvaluation(event: unknown, options: BraintrustEvaluationOptions = {}): EvaluationDraft {
  const value = object(event);
  const metadata = object(value.metadata);
  const rawScores = object(value.scores);
  const threshold = options.passThreshold ?? 0.5;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error("Braintrust passThreshold must be 0..1");
  const checks = Object.entries(rawScores).sort(([a], [b]) => a.localeCompare(b)).flatMap(([id, raw]) => {
    const detail = object(raw);
    const score = typeof raw === "number" ? raw : typeof detail.score === "number" ? detail.score : typeof detail.value === "number" ? detail.value : undefined;
    if (score === undefined) return [];
    if (!Number.isFinite(score) || score < 0 || score > 1) throw new Error(`Braintrust score ${id} must be 0..1`);
    return [{ id, score, passed: score >= threshold }];
  });
  const routeId = options.routeId || string(value.route_id, metadata.route_id);
  if (!routeId) throw new Error("Braintrust import requires route_id (in the event or --route-id)");
  if (!checks.length) throw new Error("Braintrust import requires at least one numeric score");
  const evaluatedAt = string(value.evaluated_at, value.created_at, value.timestamp);
  if (evaluatedAt && Number.isNaN(Date.parse(evaluatedAt))) throw new Error("Braintrust evaluated_at must be an RFC3339 timestamp");
  const externalId = string(value.span_id, value.id);
  const evaluatorId = options.evaluatorId || string(value.evaluator_id, value.experiment_name, value.project_name) || "braintrust";
  const replayKey = externalId || (evaluatedAt ? [routeId, evaluatorId, evaluatedAt, ...checks.map((check) => `${check.id}:${check.score}`)].join("\u0000") : undefined);
  return {
    route_id: routeId,
    ...(replayKey ? { observation_id: stableBraintrustObservationId(replayKey) } : {}),
    evaluator: {
      id: evaluatorId,
      ...(options.evaluatorVersion || string(value.evaluator_version) ? { version: options.evaluatorVersion || string(value.evaluator_version) } : {}),
    },
    checks,
    ...(evaluatedAt ? { evaluated_at: new Date(evaluatedAt).toISOString() } : {}),
    ...(externalId ? { trajectory_ref: `braintrust:${externalId}` } : {}),
  };
}

/** Deterministic minimal evaluator: weighted checklist, with required checks fail-closed. */
export function evaluateChecklist(draft: EvaluationDraft): EvaluationResult {
  if (!draft.route_id || !draft.evaluator?.id) throw new Error("evaluation requires route_id and evaluator.id");
  if (!Array.isArray(draft.checks) || !draft.checks.length) throw new Error("evaluation requires at least one check");
  const ids = new Set<string>();
  let earned = 0;
  let possible = 0;
  for (const check of draft.checks) {
    if (!check.id || ids.has(check.id)) throw new Error(`evaluation check IDs must be unique and non-empty: ${check.id || "<empty>"}`);
    ids.add(check.id);
    const weight = check.weight ?? 1;
    if (!Number.isFinite(weight) || weight <= 0) throw new Error(`${check.id}: weight must be > 0`);
    possible += weight;
    if (check.score !== undefined && (!Number.isFinite(check.score) || check.score < 0 || check.score > 1)) throw new Error(`${check.id}: score must be 0..1`);
    earned += weight * (check.score ?? (check.passed ? 1 : 0));
  }
  validateMetric("latency_ms", draft.latency_ms);
  validateMetric("cost_usd", draft.cost_usd);
  const quality = Number((earned / possible).toFixed(6));
  const requiredFailed = draft.checks.some((check) => check.required && !check.passed);
  return {
    evaluation_version: "0.1",
    route_id: draft.route_id,
    evaluated_at: draft.evaluated_at || new Date().toISOString(),
    evaluator: draft.evaluator,
    status: requiredFailed ? "failure" : quality === 1 ? "success" : "partial",
    quality,
    checks: draft.checks,
  };
}

export function evaluationToObservation(draft: EvaluationDraft, previous?: RouteOutcome): RouteObservation {
  const evaluation = evaluateChecklist(draft);
  return createRouteObservation({
    route_id: draft.route_id,
    ...(draft.observation_id ? { observation_id: draft.observation_id } : {}),
    observed_at: evaluation.evaluated_at,
    outcome: {
      status: evaluation.status,
      quality: evaluation.quality,
      ...(draft.actual_model || previous?.actual_model ? { actual_model: draft.actual_model || previous?.actual_model } : {}),
      ...(draft.actual_provider || previous?.actual_provider ? { actual_provider: draft.actual_provider || previous?.actual_provider } : {}),
      ...(draft.latency_ms !== undefined || previous?.latency_ms !== undefined ? { latency_ms: draft.latency_ms ?? previous?.latency_ms } : {}),
      ...(draft.cost_usd !== undefined || previous?.cost_usd !== undefined ? { cost_usd: draft.cost_usd ?? previous?.cost_usd } : {}),
      ...(draft.trajectory_ref || previous?.trajectory_ref ? { trajectory_ref: draft.trajectory_ref || previous?.trajectory_ref } : {}),
      metadata: {
        ...(previous?.metadata || {}),
        evaluator: evaluation.evaluator,
        checks: evaluation.checks.map((check) => ({ id: check.id, passed: check.passed, ...(check.score !== undefined ? { score: check.score } : {}), required: check.required === true })),
      },
    },
  });
}
