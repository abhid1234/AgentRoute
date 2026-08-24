import { createRouteObservation } from "./route.js";
import type { RouteObservation, RouteOutcome, RouteOutcomeStatus } from "./route-types.js";

export interface EvaluationCheck {
  id: string;
  passed: boolean;
  weight?: number;
  required?: boolean;
  note?: string;
}

export interface EvaluationDraft {
  route_id: string;
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
    if (check.passed) earned += weight;
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
        checks: evaluation.checks.map((check) => ({ id: check.id, passed: check.passed, required: check.required === true })),
      },
    },
  });
}
