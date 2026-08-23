// AgentRoute core: normalization, append-only ledger folding, explanations,
// policy auditing, and deterministic replay analytics. Zero runtime deps.
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { ROUTE_VERSION } from "./route-types.js";
import type {
  RouteCandidate,
  RouteDecision,
  RouteModelStats,
  RouteObservation,
  RouteRecord,
  RouteReplayReport,
  RouteSimulationPolicy,
  RouteSimulationReport,
  RouteState,
} from "./route-types.js";
import { assertRouteRecord, validateRouteLedger } from "./route-validate.js";

type DecisionDraft = Omit<RouteDecision, "route_version" | "record_type" | "route_id" | "created_at"> & {
  route_id?: string;
  created_at?: string;
};

type ObservationDraft = Omit<RouteObservation, "route_version" | "record_type" | "observation_id" | "observed_at"> & {
  observation_id?: string;
  observed_at?: string;
};

const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

export function fingerprintTask(value: unknown): string {
  return `sha256:${createHash("sha256").update(stable(value)).digest("hex")}`;
}

export function createRouteDecision(draft: DecisionDraft): RouteDecision {
  const decision: RouteDecision = {
    ...draft,
    route_version: ROUTE_VERSION,
    record_type: "decision",
    route_id: draft.route_id || `route_${randomUUID()}`,
    created_at: draft.created_at || new Date().toISOString(),
  };
  return assertRouteRecord(decision) as RouteDecision;
}

export function createRouteObservation(draft: ObservationDraft): RouteObservation {
  const observation: RouteObservation = {
    ...draft,
    route_version: ROUTE_VERSION,
    record_type: "observation",
    observation_id: draft.observation_id || `obs_${randomUUID()}`,
    observed_at: draft.observed_at || new Date().toISOString(),
  };
  return assertRouteRecord(observation) as RouteObservation;
}

export function parseRouteRecords(text: string, hint = "input"): RouteRecord[] {
  const normalized = text.replace(/^\uFEFF/, "");
  const trimmed = normalized.trim();
  if (!trimmed) throw new Error(`${hint} is empty`);
  let values: unknown[];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    values = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    values = normalized.split("\n").flatMap((line, index) => {
      if (!line.trim()) return [];
      try { return [JSON.parse(line)]; }
      catch (error) { throw new Error(`${hint}:${index + 1}: invalid JSON: ${String((error as Error).message)}`); }
    });
  }
  if (!Array.isArray(values)) throw new Error(`${hint} must contain a record or record array`);
  const ledger = validateRouteLedger(values);
  if (!ledger.valid) throw new Error(`AgentRoute ledger validation failed:\n  - ${ledger.errors.join("\n  - ")}`);
  return values as RouteRecord[];
}

export function loadRouteRecords(path: string): RouteRecord[] {
  return parseRouteRecords(readFileSync(path, "utf8"), path);
}

export function foldRouteRecords(records: RouteRecord[]): Map<string, RouteState> {
  const result = new Map<string, RouteState>();
  for (const record of records) {
    if (record.record_type === "decision") {
      result.set(record.route_id, { decision: record, observations: [] });
      continue;
    }
    const state = result.get(record.route_id);
    if (!state) throw new Error(`observation precedes decision for ${record.route_id}`);
    state.observations.push(record);
    state.latest_observation = record;
  }
  return result;
}

export function policyViolations(decision: RouteDecision): string[] {
  const selected = decision.candidates.find((candidate) => candidate.id === decision.selection.candidate_id)!;
  const criteria = decision.criteria;
  const violations: string[] = [];
  if (selected.eligible === false) violations.push("selected candidate was marked ineligible");
  if (!criteria) return violations;
  if (criteria.max_cost_usd !== undefined && selected.estimates?.cost_usd !== undefined && selected.estimates.cost_usd > criteria.max_cost_usd) {
    violations.push(`predicted cost ${selected.estimates.cost_usd} exceeds ceiling ${criteria.max_cost_usd}`);
  }
  if (criteria.max_latency_ms !== undefined && selected.estimates?.latency_ms !== undefined && selected.estimates.latency_ms > criteria.max_latency_ms) {
    violations.push(`predicted latency ${selected.estimates.latency_ms}ms exceeds target ${criteria.max_latency_ms}ms`);
  }
  if (criteria.min_quality !== undefined && selected.estimates?.quality !== undefined && selected.estimates.quality < criteria.min_quality) {
    violations.push(`predicted quality ${selected.estimates.quality} is below floor ${criteria.min_quality}`);
  }
  if (criteria.required_capabilities?.length) {
    const actual = new Set(selected.capabilities || []);
    const missing = criteria.required_capabilities.filter((capability) => !actual.has(capability));
    if (missing.length) violations.push(`missing required capabilities: ${missing.join(", ")}`);
  }
  return violations;
}

function bestAlternative(decision: RouteDecision): RouteCandidate | undefined {
  return decision.candidates
    .filter((candidate) => candidate.id !== decision.selection.candidate_id && candidate.eligible !== false && candidate.scores?.overall !== undefined)
    .sort((a, b) => (b.scores!.overall! - a.scores!.overall!) || a.id.localeCompare(b.id))[0];
}

export function predictedScoreGap(decision: RouteDecision): number | undefined {
  if (decision.source.fidelity !== "full") return undefined;
  const selected = decision.candidates.find((candidate) => candidate.id === decision.selection.candidate_id);
  const alternative = bestAlternative(decision);
  if (selected?.scores?.overall === undefined || !alternative) return undefined;
  return selected.scores.overall - alternative.scores!.overall!;
}

export function explainRoute(state: RouteState): string {
  const decision = state.decision;
  const selected = decision.candidates.find((candidate) => candidate.id === decision.selection.candidate_id)!;
  const lines = [
    `${decision.route_id}: selected ${selected.model}${selected.provider ? ` via ${selected.provider}` : ""}`,
    `  task: ${decision.task.type}`,
    `  router: ${decision.router.name}${decision.router.policy_id ? ` / ${decision.router.policy_id}` : ""}`,
    `  confidence: ${decision.selection.confidence ?? "not recorded"}`,
    `  reason: ${decision.selection.reason}`,
    `  evidence fidelity: ${decision.source.fidelity}`,
  ];
  const violations = policyViolations(decision);
  if (violations.length) for (const violation of violations) lines.push(`  POLICY VIOLATION: ${violation}`);
  for (const candidate of decision.candidates) {
    if (candidate.id === selected.id) continue;
    const score = candidate.scores?.overall === undefined ? "score unknown" : `score ${candidate.scores.overall}`;
    const eligibility = candidate.eligible === false ? `ineligible${candidate.ineligible_reasons?.length ? `: ${candidate.ineligible_reasons.join(", ")}` : ""}` : "eligible";
    lines.push(`  rejected: ${candidate.model}${candidate.provider ? ` via ${candidate.provider}` : ""} (${score}; ${eligibility})`);
  }
  const gap = predictedScoreGap(decision);
  if (gap !== undefined) lines.push(`  predicted selected-vs-best-alternative score gap: ${gap.toFixed(4)} (not actual regret)`);
  if (state.latest_observation) {
    const outcome = state.latest_observation.outcome;
    lines.push(`  observed: ${outcome.status}${outcome.latency_ms !== undefined ? `; ${outcome.latency_ms}ms` : ""}${outcome.cost_usd !== undefined ? `; $${outcome.cost_usd}` : ""}${outcome.quality !== undefined ? `; quality ${outcome.quality}` : ""}`);
  } else lines.push("  observed: pending");
  if (decision.source.fidelity !== "full") lines.push("  caveat: alternatives are incomplete; no counterfactual comparison was inferred");
  return lines.join("\n");
}

const mean = (values: number[]): number | undefined => values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined;
const rounded = (value: number | undefined, digits = 6): number | undefined => value === undefined ? undefined : Number(value.toFixed(digits));

export function replayRoutes(records: RouteRecord[], generatedAt = new Date().toISOString()): RouteReplayReport {
  const states = [...foldRouteRecords(records).values()];
  const modelBuckets = new Map<string, { model: string; provider?: string; observations: RouteObservation[]; selections: number }>();
  const byTaskType: Record<string, number> = {};
  const warnings: string[] = [];
  let policyViolationCount = 0;
  const gaps: number[] = [];

  for (const state of states) {
    const decision = state.decision;
    const selected = decision.candidates.find((candidate) => candidate.id === decision.selection.candidate_id)!;
    const key = `${selected.provider || ""}\u0000${selected.model}`;
    const bucket = modelBuckets.get(key) || { model: selected.model, provider: selected.provider, observations: [], selections: 0 };
    bucket.selections++;
    if (state.latest_observation) bucket.observations.push(state.latest_observation);
    modelBuckets.set(key, bucket);
    byTaskType[decision.task.type] = (byTaskType[decision.task.type] || 0) + 1;
    if (policyViolations(decision).length) policyViolationCount++;
    const gap = predictedScoreGap(decision);
    if (gap !== undefined) gaps.push(gap);
    if (decision.source.fidelity !== "full") warnings.push(`${decision.route_id}: ${decision.source.fidelity} evidence; alternatives may be missing`);
  }

  const byModel: RouteModelStats[] = [...modelBuckets.values()].map((bucket) => {
    const outcomes = bucket.observations.map((observation) => observation.outcome);
    const successes = outcomes.filter((outcome) => outcome.status === "success").length;
    const metrics = (key: "latency_ms" | "cost_usd" | "quality") => outcomes.map((outcome) => outcome[key]).filter((value): value is number => value !== undefined);
    return {
      model: bucket.model,
      ...(bucket.provider ? { provider: bucket.provider } : {}),
      selections: bucket.selections,
      observations: outcomes.length,
      successes,
      ...(outcomes.length ? { success_rate: rounded(successes / outcomes.length) } : {}),
      ...(metrics("latency_ms").length ? { mean_latency_ms: rounded(mean(metrics("latency_ms"))) } : {}),
      ...(metrics("cost_usd").length ? { mean_cost_usd: rounded(mean(metrics("cost_usd"))) } : {}),
      ...(metrics("quality").length ? { mean_quality: rounded(mean(metrics("quality"))) } : {}),
    };
  }).sort((a, b) => b.selections - a.selections || `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`));

  const observed = states.filter((state) => state.latest_observation).length;
  return {
    route_version: ROUTE_VERSION,
    generated_at: generatedAt,
    decisions: states.length,
    observed,
    observation_coverage: rounded(states.length ? observed / states.length : 0)!,
    full_fidelity_decisions: states.filter((state) => state.decision.source.fidelity === "full").length,
    policy_violations: policyViolationCount,
    ...(gaps.length ? { predicted_score_gap_mean: rounded(mean(gaps)) } : {}),
    by_model: byModel,
    by_task_type: Object.fromEntries(Object.entries(byTaskType).sort(([a], [b]) => a.localeCompare(b))),
    warnings,
  };
}

function candidateMeets(candidate: RouteCandidate, criteria: RouteSimulationPolicy["criteria"]): boolean {
  if (candidate.eligible === false) return false;
  if (!criteria) return true;
  if (criteria.max_cost_usd !== undefined && (candidate.estimates?.cost_usd === undefined || candidate.estimates.cost_usd > criteria.max_cost_usd)) return false;
  if (criteria.max_latency_ms !== undefined && (candidate.estimates?.latency_ms === undefined || candidate.estimates.latency_ms > criteria.max_latency_ms)) return false;
  if (criteria.min_quality !== undefined && (candidate.estimates?.quality === undefined || candidate.estimates.quality < criteria.min_quality)) return false;
  if (criteria.required_capabilities?.length) {
    const actual = new Set(candidate.capabilities || []);
    if (criteria.required_capabilities.some((capability) => !actual.has(capability))) return false;
  }
  return true;
}

function policyScore(candidate: RouteCandidate, policy: RouteSimulationPolicy): number | undefined {
  const dimensions = ["quality", "latency", "cost", "capability"] as const;
  let totalWeight = 0;
  let total = 0;
  for (const dimension of dimensions) {
    const weight = policy.weights[dimension] || 0;
    if (!weight) continue;
    const score = candidate.scores?.[dimension];
    if (score === undefined) return undefined;
    totalWeight += weight;
    total += weight * score;
  }
  return totalWeight ? total / totalWeight : undefined;
}

/**
 * Re-score only the complete, recorded candidate set under a caller-supplied
 * policy. This is a predicted policy simulation, never counterfactual outcome
 * or actual-regret analysis.
 */
export function simulateRoutePolicy(records: RouteRecord[], policy: RouteSimulationPolicy, generatedAt = new Date().toISOString()): RouteSimulationReport {
  if (!policy || typeof policy !== "object" || typeof policy.id !== "string" || !policy.id) throw new Error("simulation policy requires `id`");
  if (!policy.weights || typeof policy.weights !== "object" || Array.isArray(policy.weights)) throw new Error("simulation policy requires `weights`");
  const weights = Object.values(policy.weights);
  if (!weights.length || weights.some((weight) => !Number.isFinite(weight) || weight < 0 || weight > 1) || !weights.some((weight) => weight > 0)) {
    throw new Error("simulation policy requires at least one positive weight in the range 0..1");
  }
  if (Math.abs(weights.reduce((sum, weight) => sum + weight, 0) - 1) > 1e-9) throw new Error("simulation policy weights must sum to 1");
  const criteria = policy.criteria;
  if (criteria?.max_cost_usd !== undefined && (!Number.isFinite(criteria.max_cost_usd) || criteria.max_cost_usd < 0)) throw new Error("simulation criteria.max_cost_usd must be >= 0");
  if (criteria?.max_latency_ms !== undefined && (!Number.isFinite(criteria.max_latency_ms) || criteria.max_latency_ms < 0)) throw new Error("simulation criteria.max_latency_ms must be >= 0");
  if (criteria?.min_quality !== undefined && (!Number.isFinite(criteria.min_quality) || criteria.min_quality < 0 || criteria.min_quality > 1)) throw new Error("simulation criteria.min_quality must be 0..1");
  if (criteria?.required_capabilities !== undefined && (!Array.isArray(criteria.required_capabilities) || criteria.required_capabilities.some((value) => typeof value !== "string" || !value))) throw new Error("simulation criteria.required_capabilities must contain non-empty strings");
  const states = [...foldRouteRecords(records).values()];
  const choices: RouteSimulationReport["choices"] = [];
  const warnings: string[] = [];
  let skippedIncomplete = 0;
  let skippedUnscorable = 0;
  for (const { decision } of states) {
    if (decision.source.fidelity !== "full") {
      skippedIncomplete++;
      warnings.push(`${decision.route_id}: skipped ${decision.source.fidelity} candidate evidence`);
      continue;
    }
    const allScored = decision.candidates
      .map((candidate) => ({ candidate, score: policyScore(candidate, policy) }))
      .filter((entry): entry is { candidate: RouteCandidate; score: number } => entry.score !== undefined);
    const scored = allScored
      .filter((entry) => candidateMeets(entry.candidate, policy.criteria))
      .sort((a, b) => b.score - a.score || a.candidate.id.localeCompare(b.candidate.id));
    const original = allScored.find((entry) => entry.candidate.id === decision.selection.candidate_id);
    if (!scored.length || !original) {
      skippedUnscorable++;
      warnings.push(`${decision.route_id}: selected candidate or eligible alternatives lacked required policy scores`);
      continue;
    }
    const winner = scored[0];
    choices.push({
      route_id: decision.route_id,
      original_candidate_id: decision.selection.candidate_id,
      simulated_candidate_id: winner.candidate.id,
      changed: winner.candidate.id !== decision.selection.candidate_id,
      predicted_score_delta: rounded(winner.score - original.score)!,
    });
  }
  return {
    route_version: ROUTE_VERSION,
    policy_id: policy.id,
    ...(policy.version ? { policy_version: policy.version } : {}),
    generated_at: generatedAt,
    decisions: states.length,
    simulated: choices.length,
    changed: choices.filter((choice) => choice.changed).length,
    skipped_incomplete_evidence: skippedIncomplete,
    skipped_unscorable: skippedUnscorable,
    choices,
    warnings,
  };
}

export function writeRouteDecision(path: string, decision: RouteDecision, force = false): "written" | "unchanged" {
  const json = JSON.stringify(decision, null, 2) + "\n";
  if (existsSync(path)) {
    const current = readFileSync(path, "utf8");
    if (stable(JSON.parse(current)) === stable(decision)) return "unchanged";
    if (!force) throw new Error(`${path} exists with different content (use --force to replace)`);
  }
  const temp = `${path}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temp, json);
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
  return "written";
}

export function appendRouteRecord(path: string, record: RouteRecord): "appended" | "unchanged" {
  if (!path.endsWith(".jsonl")) throw new Error("append-only AgentRoute ledgers must use a .jsonl path");
  assertRouteRecord(record);
  const existing = existsSync(path) ? loadRouteRecords(path) : [];
  const id = record.record_type === "decision" ? record.route_id : record.observation_id;
  const duplicate = existing.find((candidate) =>
    record.record_type === "decision"
      ? candidate.record_type === "decision" && candidate.route_id === record.route_id
      : candidate.record_type === "observation" && candidate.observation_id === record.observation_id,
  );
  if (duplicate) {
    if (stable(duplicate) === stable(record)) return "unchanged";
    throw new Error(`record id ${id} already exists with different content`);
  }
  const next = [...existing, record];
  const validation = validateRouteLedger(next);
  if (!validation.valid) throw new Error(`refusing invalid ledger append:\n  - ${validation.errors.join("\n  - ")}`);
  appendFileSync(path, JSON.stringify(record) + "\n");
  return "appended";
}
