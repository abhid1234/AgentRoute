import { createHash } from "node:crypto";
import type { RouteCandidate, RouteDecision, RouteOutcome, RouteRecord } from "./route-types.js";
import { createRouteDecision, createRouteObservation, foldRouteRecords } from "./route.js";

export interface ReplayArenaTask {
  route_id: string;
  task_ref: string;
  candidate_ids?: string[];
}

export interface ReplayExecutionRequest {
  original_route_id: string;
  task_ref: string;
  candidate: RouteCandidate;
}

export interface ReplayExecutor {
  id: string;
  estimateCostUsd(request: ReplayExecutionRequest): number | undefined;
  execute(request: ReplayExecutionRequest): Promise<RouteOutcome>;
}

export interface ReplayArenaLimits {
  max_requests: number;
  max_cost_usd: number;
}

export interface ReplayArenaOptions {
  tasks: ReplayArenaTask[];
  limits: ReplayArenaLimits;
  executor: ReplayExecutor;
  run_id?: string;
  generated_at?: string;
}

export interface ReplayArenaComparison {
  original_route_id: string;
  measured_candidates: number;
  winner_candidate_id?: string;
  original_candidate_id: string;
  actual_quality_regret?: number;
}

export interface ReplayArenaReport {
  arena_version: "0.1";
  run_id: string;
  generated_at: string;
  executor_id: string;
  evidence_mode: "offline_conformance" | "user_supplied_execution";
  result_label: "illustrative" | "user_generated";
  requests_executed: number;
  requests_skipped: number;
  estimated_cost_usd: number;
  actual_cost_usd: number;
  stopped_reason?: "request_limit" | "cost_limit";
  comparisons: ReplayArenaComparison[];
  records: RouteRecord[];
}

export interface ReplayFixture {
  route_id: string;
  candidate_id: string;
  estimated_cost_usd: number;
  outcome: RouteOutcome;
}

const rounded = (value: number): number => Number(value.toFixed(6));
const stableId = (prefix: string, value: string): string => `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;

function safeOutcome(outcome: RouteOutcome): RouteOutcome {
  return {
    status: outcome.status,
    ...(outcome.actual_model ? { actual_model: outcome.actual_model } : {}),
    ...(outcome.actual_provider ? { actual_provider: outcome.actual_provider } : {}),
    ...(outcome.latency_ms !== undefined ? { latency_ms: outcome.latency_ms } : {}),
    ...(outcome.cost_usd !== undefined ? { cost_usd: outcome.cost_usd } : {}),
    ...(outcome.quality !== undefined ? { quality: outcome.quality } : {}),
    ...(outcome.trajectory_ref ? { trajectory_ref: outcome.trajectory_ref } : {}),
  };
}

function validateOutcome(outcome: RouteOutcome): void {
  if (!outcome || typeof outcome !== "object") throw new Error("replay executor returned an invalid outcome");
  if (!["success", "failure", "partial", "cancelled", "unknown"].includes(outcome.status)) throw new Error(`invalid replay outcome status: ${outcome.status}`);
  for (const key of ["latency_ms", "cost_usd"] as const) {
    if (outcome[key] !== undefined && (!Number.isFinite(outcome[key]) || outcome[key]! < 0)) throw new Error(`replay outcome ${key} must be non-negative`);
  }
  if (outcome.quality !== undefined && (!Number.isFinite(outcome.quality) || outcome.quality < 0 || outcome.quality > 1)) throw new Error("replay outcome quality must be 0..1");
}

export function fixtureReplayExecutor(fixtures: ReplayFixture[]): ReplayExecutor {
  const byKey = new Map<string, ReplayFixture>();
  for (const fixture of fixtures) {
    const key = `${fixture.route_id}\u0000${fixture.candidate_id}`;
    if (byKey.has(key)) throw new Error(`duplicate replay fixture: ${fixture.route_id}/${fixture.candidate_id}`);
    if (!Number.isFinite(fixture.estimated_cost_usd) || fixture.estimated_cost_usd < 0) throw new Error(`${fixture.route_id}/${fixture.candidate_id}: estimated_cost_usd must be non-negative`);
    validateOutcome(fixture.outcome);
    byKey.set(key, fixture);
  }
  const get = (request: ReplayExecutionRequest): ReplayFixture => {
    const fixture = byKey.get(`${request.original_route_id}\u0000${request.candidate.id}`);
    if (!fixture) throw new Error(`missing replay fixture: ${request.original_route_id}/${request.candidate.id}`);
    return fixture;
  };
  return {
    id: "offline-fixtures",
    estimateCostUsd: (request) => get(request).estimated_cost_usd,
    execute: async (request) => safeOutcome(get(request).outcome),
  };
}

export async function runReplayArena(records: RouteRecord[], options: ReplayArenaOptions): Promise<ReplayArenaReport> {
  const { max_requests: maxRequests, max_cost_usd: maxCost } = options.limits;
  if (!Number.isInteger(maxRequests) || maxRequests <= 0) throw new Error("max_requests must be a positive integer");
  if (!Number.isFinite(maxCost) || maxCost < 0) throw new Error("max_cost_usd must be non-negative");
  if (!Array.isArray(options.tasks) || !options.tasks.length) throw new Error("replay arena requires at least one task");
  const states = foldRouteRecords(records);
  const runId = options.run_id || stableId("arena", `${options.executor.id}\u0000${Date.now()}`);
  const generatedAt = options.generated_at || new Date().toISOString();
  const planned = options.tasks.map((task) => {
    const state = states.get(task.route_id);
    if (!state) throw new Error(`replay task route_id not found: ${task.route_id}`);
    if (!task.task_ref || typeof task.task_ref !== "string") throw new Error(`${task.route_id}: task_ref is required`);
    const requested = task.candidate_ids?.length ? new Set(task.candidate_ids) : undefined;
    if (requested) {
      const missing = [...requested].filter((id) => !state.decision.candidates.some((candidate) => candidate.id === id));
      if (missing.length) throw new Error(`${task.route_id}: unknown candidate_ids: ${missing.join(", ")}`);
    }
    const candidates = state.decision.candidates.filter((candidate) => candidate.eligible !== false && (!requested || requested.has(candidate.id)));
    return { task, state, candidates };
  });
  const output: RouteRecord[] = [];
  const outcomes = new Map<string, Array<{ candidate: RouteCandidate; quality?: number }>>();
  let estimatedCost = 0;
  let actualCost = 0;
  let skipped = 0;
  let stoppedReason: ReplayArenaReport["stopped_reason"];

  outer: for (let taskIndex = 0; taskIndex < planned.length; taskIndex++) {
    const { task, state, candidates } = planned[taskIndex];
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
      const candidate = candidates[candidateIndex];
      const remaining = (): number => candidates.length - candidateIndex + planned.slice(taskIndex + 1).reduce((sum, item) => sum + item.candidates.length, 0);
      if (output.length / 2 >= maxRequests) {
        skipped += remaining();
        stoppedReason = "request_limit";
        break outer;
      }
      const request: ReplayExecutionRequest = { original_route_id: task.route_id, task_ref: task.task_ref, candidate };
      const estimate = options.executor.estimateCostUsd(request);
      if (estimate === undefined || !Number.isFinite(estimate) || estimate < 0) throw new Error(`${task.route_id}/${candidate.id}: executor must provide a non-negative cost estimate`);
      if (estimatedCost + estimate > maxCost + 1e-12) {
        skipped += remaining();
        stoppedReason = "cost_limit";
        break outer;
      }
      estimatedCost += estimate;
      const outcome = await options.executor.execute(request);
      validateOutcome(outcome);
      actualCost += outcome.cost_usd || 0;
      if (actualCost > maxCost + 1e-12) throw new Error(`replay executor exceeded hard actual cost limit (${actualCost} > ${maxCost})`);
      const routeId = stableId("replay", `${runId}\u0000${task.route_id}\u0000${candidate.id}`);
      const decision: RouteDecision = createRouteDecision({
        route_id: routeId,
        created_at: generatedAt,
        task: { type: state.decision.task.type, fingerprint: state.decision.task.fingerprint },
        router: { name: "agentroute-replay-arena", version: "0.1" },
        source: { kind: "custom", fidelity: "selected-only", event_id: runId },
        candidates: [{ ...candidate, endpoint: undefined }],
        criteria: state.decision.criteria,
        selection: { candidate_id: candidate.id, reason: "explicit shadow replay candidate" },
        context: { parent_route_id: task.route_id },
        extensions: { arena_run_id: runId, task_ref: task.task_ref, original_route_id: task.route_id, original_candidate_id: candidate.id },
      });
      const observation = createRouteObservation({
        route_id: routeId,
        observation_id: stableId("obs", routeId),
        observed_at: generatedAt,
        outcome: safeOutcome(outcome),
        extensions: { arena_run_id: runId, original_route_id: task.route_id, original_candidate_id: candidate.id },
      });
      output.push(decision, observation);
      const group = outcomes.get(task.route_id) || [];
      group.push({ candidate, quality: outcome.quality });
      outcomes.set(task.route_id, group);
    }
  }

  const comparisons = options.tasks.map((task): ReplayArenaComparison => {
    const state = states.get(task.route_id)!;
    const measured = outcomes.get(task.route_id) || [];
    const scored = measured.filter((entry): entry is { candidate: RouteCandidate; quality: number } => entry.quality !== undefined)
      .sort((a, b) => b.quality - a.quality || a.candidate.id.localeCompare(b.candidate.id));
    const original = scored.find((entry) => entry.candidate.id === state.decision.selection.candidate_id);
    return {
      original_route_id: task.route_id,
      measured_candidates: measured.length,
      ...(scored.length >= 2 ? { winner_candidate_id: scored[0].candidate.id } : {}),
      original_candidate_id: state.decision.selection.candidate_id,
      ...(scored.length >= 2 && original ? { actual_quality_regret: rounded(scored[0].quality - original.quality) } : {}),
    };
  });
  return {
    arena_version: "0.1",
    run_id: runId,
    generated_at: generatedAt,
    executor_id: options.executor.id,
    evidence_mode: options.executor.id === "offline-fixtures" ? "offline_conformance" : "user_supplied_execution",
    result_label: options.executor.id === "offline-fixtures" ? "illustrative" : "user_generated",
    requests_executed: output.length / 2,
    requests_skipped: skipped,
    estimated_cost_usd: rounded(estimatedCost),
    actual_cost_usd: rounded(actualCost),
    ...(stoppedReason ? { stopped_reason: stoppedReason } : {}),
    comparisons,
    records: output,
  };
}
