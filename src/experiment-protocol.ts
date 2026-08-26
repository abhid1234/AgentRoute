import { canonicalJson, sha256 } from "./canonical.js";
import { analyzeReplayExperiment } from "./experiment.js";
import type { ExperimentCandidateStats, ExperimentPairwiseComparison, ExperimentSliceReport, ReplayExperimentReport } from "./experiment.js";
import type { RouteRecord } from "./route-types.js";

export interface ExperimentProtocolThresholds {
  minimum_mean_quality_delta?: number;
  minimum_quality_win_rate_95ci_low?: number;
  maximum_mean_latency_delta_ms?: number;
  maximum_mean_cost_delta_usd?: number;
  minimum_success_rate_delta?: number;
}

export interface ExperimentProtocol {
  protocol_version: "0.1";
  id: string;
  description?: string;
  baseline_candidate_id: string;
  challenger_candidate_id: string;
  minimum_matched_pairs: number;
  minimum_slice_matched_pairs?: number;
  quality_tie_tolerance?: number;
  thresholds: ExperimentProtocolThresholds;
  required_task_types?: string[];
}

export interface ExperimentDecisionCheck {
  id: string;
  scope: "global" | `task_type:${string}`;
  kind: "coverage" | "threshold";
  metric: string;
  operator: "gte" | "lte";
  threshold: number;
  actual?: number;
  status: "pass" | "fail" | "insufficient";
  message: string;
}

export interface ExperimentDecision {
  decision_version: "0.1";
  protocol_id: string;
  protocol_sha256: string;
  evidence_sha256: string;
  generated_at: string;
  status: "pass" | "fail" | "insufficient";
  checks: ExperimentDecisionCheck[];
  analysis: ReplayExperimentReport;
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const round = (value: number): number => Number(value.toFixed(6));

function candidateId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) throw new Error(`${label} must be a stable candidate identifier`);
  return value;
}

export function validateExperimentProtocol(value: unknown): ExperimentProtocol {
  if (!object(value) || value.protocol_version !== "0.1") throw new Error("experiment protocol_version must equal 0.1");
  if (typeof value.id !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(value.id)) throw new Error("experiment protocol id must be a lowercase stable identifier");
  const baseline = candidateId(value.baseline_candidate_id, "baseline_candidate_id");
  const challenger = candidateId(value.challenger_candidate_id, "challenger_candidate_id");
  if (baseline === challenger) throw new Error("experiment baseline and challenger must differ");
  if (!Number.isInteger(value.minimum_matched_pairs) || (value.minimum_matched_pairs as number) <= 0) throw new Error("minimum_matched_pairs must be a positive integer");
  if (value.minimum_slice_matched_pairs !== undefined && (!Number.isInteger(value.minimum_slice_matched_pairs) || (value.minimum_slice_matched_pairs as number) <= 0)) throw new Error("minimum_slice_matched_pairs must be a positive integer");
  if (value.quality_tie_tolerance !== undefined && (!finite(value.quality_tie_tolerance) || value.quality_tie_tolerance < 0 || value.quality_tie_tolerance > 1)) throw new Error("quality_tie_tolerance must be 0..1");
  if (!object(value.thresholds)) throw new Error("experiment protocol thresholds are required");
  const thresholds = value.thresholds;
  const qualityDelta = thresholds.minimum_mean_quality_delta;
  const winRateLow = thresholds.minimum_quality_win_rate_95ci_low;
  if (qualityDelta === undefined && winRateLow === undefined) throw new Error("experiment protocol requires at least one quality success threshold");
  if (qualityDelta !== undefined && (!finite(qualityDelta) || qualityDelta < -1 || qualityDelta > 1)) throw new Error("minimum_mean_quality_delta must be -1..1");
  if (winRateLow !== undefined && (!finite(winRateLow) || winRateLow < 0 || winRateLow > 1)) throw new Error("minimum_quality_win_rate_95ci_low must be 0..1");
  for (const key of ["maximum_mean_latency_delta_ms", "maximum_mean_cost_delta_usd"] as const) {
    if (thresholds[key] !== undefined && !finite(thresholds[key])) throw new Error(`${key} must be finite`);
  }
  if (thresholds.minimum_success_rate_delta !== undefined && (!finite(thresholds.minimum_success_rate_delta) || thresholds.minimum_success_rate_delta < -1 || thresholds.minimum_success_rate_delta > 1)) throw new Error("minimum_success_rate_delta must be -1..1");
  if (value.required_task_types !== undefined) {
    if (!Array.isArray(value.required_task_types) || value.required_task_types.some((item) => typeof item !== "string" || !item.trim())) throw new Error("required_task_types must contain non-empty strings");
    if (new Set(value.required_task_types).size !== value.required_task_types.length) throw new Error("required_task_types must be unique");
  }
  if (value.description !== undefined && (typeof value.description !== "string" || !value.description.trim())) throw new Error("experiment protocol description must be non-empty");
  return value as unknown as ExperimentProtocol;
}

function checkStatus(kind: ExperimentDecisionCheck["kind"], operator: ExperimentDecisionCheck["operator"], actual: number | undefined, threshold: number): ExperimentDecisionCheck["status"] {
  if (actual === undefined) return "insufficient";
  if (kind === "coverage" && !(operator === "gte" ? actual >= threshold : actual <= threshold)) return "insufficient";
  return operator === "gte" ? actual >= threshold ? "pass" : "fail" : actual <= threshold ? "pass" : "fail";
}

function addCheck(checks: ExperimentDecisionCheck[], input: Omit<ExperimentDecisionCheck, "status" | "message">, label: string): void {
  const status = checkStatus(input.kind, input.operator, input.actual, input.threshold);
  const measured = input.actual === undefined ? "not measured" : String(input.actual);
  const comparison = input.operator === "gte" ? "minimum" : "maximum";
  checks.push({ ...input, status, message: `${label}: ${measured}; ${comparison} ${input.threshold}` });
}

function comparisonFor(report: ExperimentSliceReport): ExperimentPairwiseComparison | undefined {
  return report.comparisons[0];
}

function candidateFor(report: ExperimentSliceReport, id: string): ExperimentCandidateStats | undefined {
  return report.candidates.find((candidate) => candidate.candidate_id === id);
}

function validateAnalysisScope(report: unknown, scope: string, protocol: ExperimentProtocol): asserts report is ExperimentSliceReport {
  if (!object(report) || !Array.isArray(report.candidates) || !Array.isArray(report.comparisons)) throw new Error(`experiment decision ${scope} analysis contract is invalid`);
  for (const key of ["samples", "paired_units"] as const) if (!Number.isInteger(report[key]) || (report[key] as number) < 0) throw new Error(`experiment decision ${scope} ${key} must be a non-negative integer`);
  const seenCandidates = new Set<string>();
  let samples = 0;
  for (const raw of report.candidates) {
    if (!object(raw)) throw new Error(`experiment decision ${scope} candidate contract is invalid`);
    const id = candidateId(raw.candidate_id, `${scope} candidate_id`);
    if (seenCandidates.has(id)) throw new Error(`experiment decision ${scope} contains duplicate candidate ${id}`);
    seenCandidates.add(id);
    if (typeof raw.model !== "string" || !raw.model || !Number.isInteger(raw.samples) || (raw.samples as number) <= 0 || !Number.isInteger(raw.successes) || (raw.successes as number) < 0 || (raw.successes as number) > (raw.samples as number)) throw new Error(`experiment decision ${scope} candidate ${id} counts are invalid`);
    if (!finite(raw.success_rate) || raw.success_rate !== round((raw.successes as number) / (raw.samples as number))) throw new Error(`experiment decision ${scope} candidate ${id} success rate is inconsistent`);
    for (const key of ["mean_quality", "mean_latency_ms", "mean_cost_usd"] as const) if (raw[key] !== undefined && !finite(raw[key])) throw new Error(`experiment decision ${scope} candidate ${id} ${key} must be finite`);
    samples += raw.samples as number;
  }
  if (samples !== report.samples) throw new Error(`experiment decision ${scope} sample total is inconsistent`);
  if (report.comparisons.length !== 1 || !object(report.comparisons[0])) throw new Error(`experiment decision ${scope} must contain exactly one comparison`);
  const comparison = report.comparisons[0];
  if (comparison.baseline_candidate_id !== protocol.baseline_candidate_id || comparison.challenger_candidate_id !== protocol.challenger_candidate_id) throw new Error(`experiment decision ${scope} comparison does not match protocol candidates`);
  for (const key of ["matched_pairs", "quality_pairs", "challenger_quality_wins", "challenger_quality_losses", "quality_ties"] as const) if (!Number.isInteger(comparison[key]) || (comparison[key] as number) < 0) throw new Error(`experiment decision ${scope} comparison ${key} must be a non-negative integer`);
  if ((comparison.quality_pairs as number) > (comparison.matched_pairs as number) || (comparison.challenger_quality_wins as number) + (comparison.challenger_quality_losses as number) + (comparison.quality_ties as number) !== comparison.quality_pairs) throw new Error(`experiment decision ${scope} comparison counts are inconsistent`);
  for (const key of ["challenger_quality_win_rate", "mean_quality_delta", "mean_latency_delta_ms", "mean_cost_delta_usd"] as const) if (comparison[key] !== undefined && !finite(comparison[key])) throw new Error(`experiment decision ${scope} comparison ${key} must be finite`);
  const winRate = comparison.challenger_quality_win_rate;
  if (finite(winRate) && (winRate < 0 || winRate > 1)) throw new Error(`experiment decision ${scope} quality win rate is invalid`);
  if (comparison.challenger_quality_win_rate_95ci !== undefined) {
    const interval = comparison.challenger_quality_win_rate_95ci;
    if (!object(interval) || !finite(interval.low) || !finite(interval.high) || interval.low < 0 || interval.high > 1 || interval.low > interval.high) throw new Error(`experiment decision ${scope} quality interval is invalid`);
  }
}

function scopeChecks(checks: ExperimentDecisionCheck[], scope: ExperimentDecisionCheck["scope"], report: ExperimentSliceReport | undefined, protocol: ExperimentProtocol): void {
  const prefix = scope === "global" ? "global" : scope;
  if (!report) {
    addCheck(checks, { id: `${scope}:slice_present`, scope, kind: "coverage", metric: "slice_present", operator: "gte", threshold: 1 }, `${prefix} slice presence`);
    return;
  }
  const comparison = comparisonFor(report);
  const minimumPairs = scope === "global" ? protocol.minimum_matched_pairs : protocol.minimum_slice_matched_pairs ?? protocol.minimum_matched_pairs;
  addCheck(checks, { id: `${scope}:matched_pairs`, scope, kind: "coverage", metric: "matched_pairs", operator: "gte", threshold: minimumPairs, ...(comparison ? { actual: comparison.matched_pairs } : {}) }, `${prefix} matched pairs`);
  const thresholds = protocol.thresholds;
  if (thresholds.minimum_mean_quality_delta !== undefined) addCheck(checks, { id: `${scope}:mean_quality_delta`, scope, kind: "threshold", metric: "mean_quality_delta", operator: "gte", threshold: thresholds.minimum_mean_quality_delta, ...(comparison?.mean_quality_delta !== undefined ? { actual: comparison.mean_quality_delta } : {}) }, `${prefix} challenger mean quality delta`);
  if (thresholds.minimum_quality_win_rate_95ci_low !== undefined) addCheck(checks, { id: `${scope}:quality_win_rate_95ci_low`, scope, kind: "threshold", metric: "quality_win_rate_95ci_low", operator: "gte", threshold: thresholds.minimum_quality_win_rate_95ci_low, ...(comparison?.challenger_quality_win_rate_95ci?.low !== undefined ? { actual: comparison.challenger_quality_win_rate_95ci.low } : {}) }, `${prefix} challenger quality win-rate 95% lower bound`);
  if (thresholds.maximum_mean_latency_delta_ms !== undefined) addCheck(checks, { id: `${scope}:mean_latency_delta_ms`, scope, kind: "threshold", metric: "mean_latency_delta_ms", operator: "lte", threshold: thresholds.maximum_mean_latency_delta_ms, ...(comparison?.mean_latency_delta_ms !== undefined ? { actual: comparison.mean_latency_delta_ms } : {}) }, `${prefix} challenger mean latency delta ms`);
  if (thresholds.maximum_mean_cost_delta_usd !== undefined) addCheck(checks, { id: `${scope}:mean_cost_delta_usd`, scope, kind: "threshold", metric: "mean_cost_delta_usd", operator: "lte", threshold: thresholds.maximum_mean_cost_delta_usd, ...(comparison?.mean_cost_delta_usd !== undefined ? { actual: comparison.mean_cost_delta_usd } : {}) }, `${prefix} challenger mean cost delta USD`);
  if (thresholds.minimum_success_rate_delta !== undefined) {
    const baseline = candidateFor(report, protocol.baseline_candidate_id);
    const challenger = candidateFor(report, protocol.challenger_candidate_id);
    const actual = baseline && challenger ? round(challenger.success_rate - baseline.success_rate) : undefined;
    addCheck(checks, { id: `${scope}:success_rate_delta`, scope, kind: "threshold", metric: "success_rate_delta", operator: "gte", threshold: thresholds.minimum_success_rate_delta, ...(actual !== undefined ? { actual } : {}) }, `${prefix} challenger success-rate delta`);
  }
}

function overallStatus(checks: ExperimentDecisionCheck[]): ExperimentDecision["status"] {
  if (checks.some((check) => check.status === "fail")) return "fail";
  if (checks.some((check) => check.status === "insufficient")) return "insufficient";
  return "pass";
}

export function decideReplayExperiment(records: RouteRecord[], protocolValue: unknown, generatedAt = new Date().toISOString()): ExperimentDecision {
  const protocol = validateExperimentProtocol(protocolValue);
  if (Number.isNaN(Date.parse(generatedAt))) throw new Error("experiment decision generated_at must be an RFC3339 timestamp");
  const analysis = analyzeReplayExperiment(records, {
    baseline_candidate_id: protocol.baseline_candidate_id,
    challenger_candidate_ids: [protocol.challenger_candidate_id],
    quality_tie_tolerance: protocol.quality_tie_tolerance,
    generated_at: generatedAt,
  });
  const checks: ExperimentDecisionCheck[] = [];
  scopeChecks(checks, "global", analysis, protocol);
  for (const taskType of [...(protocol.required_task_types || [])].sort()) scopeChecks(checks, `task_type:${taskType}`, analysis.by_task_type[taskType], protocol);
  return {
    decision_version: "0.1",
    protocol_id: protocol.id,
    protocol_sha256: sha256(protocol),
    evidence_sha256: sha256(records),
    generated_at: generatedAt,
    status: overallStatus(checks),
    checks,
    analysis,
  };
}

export function validateExperimentDecision(value: unknown, protocolValue?: unknown): ExperimentDecision {
  if (!object(value) || value.decision_version !== "0.1") throw new Error("experiment decision_version must equal 0.1");
  if (typeof value.protocol_id !== "string" || !value.protocol_id) throw new Error("experiment decision protocol_id is required");
  if (typeof value.protocol_sha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.protocol_sha256)) throw new Error("experiment decision protocol_sha256 is invalid");
  if (typeof value.evidence_sha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.evidence_sha256)) throw new Error("experiment decision evidence_sha256 is invalid");
  if (typeof value.generated_at !== "string" || Number.isNaN(Date.parse(value.generated_at))) throw new Error("experiment decision generated_at is invalid");
  if (!Array.isArray(value.checks) || !value.checks.length) throw new Error("experiment decision checks are required");
  const checks = value.checks as unknown[];
  for (const raw of checks) {
    if (!object(raw) || typeof raw.id !== "string" || typeof raw.scope !== "string" || !["coverage", "threshold"].includes(String(raw.kind)) || !["gte", "lte"].includes(String(raw.operator)) || !finite(raw.threshold)) throw new Error("experiment decision check contract is invalid");
    if (raw.actual !== undefined && !finite(raw.actual)) throw new Error(`${raw.id}: experiment decision check actual must be finite`);
    const expected = checkStatus(raw.kind as ExperimentDecisionCheck["kind"], raw.operator as ExperimentDecisionCheck["operator"], raw.actual as number | undefined, raw.threshold);
    if (raw.status !== expected) throw new Error(`${raw.id}: experiment decision check status is inconsistent`);
    if (typeof raw.message !== "string" || !raw.message) throw new Error(`${raw.id}: experiment decision check message is required`);
  }
  const typedChecks = checks as ExperimentDecisionCheck[];
  if (value.status !== overallStatus(typedChecks)) throw new Error("experiment decision status is inconsistent with checks");
  if (!object(value.analysis) || value.analysis.experiment_version !== "0.1") throw new Error("experiment decision analysis is invalid");
  if (value.analysis.generated_at !== value.generated_at) throw new Error("experiment decision analysis timestamp is inconsistent");
  if (protocolValue !== undefined) {
    const protocol = validateExperimentProtocol(protocolValue);
    if (value.protocol_id !== protocol.id || value.protocol_sha256 !== sha256(protocol)) throw new Error("experiment decision does not match protocol");
    const analysis = value.analysis as unknown as ReplayExperimentReport;
    if (!Number.isInteger(analysis.arena_runs) || analysis.arena_runs < 0 || !Array.isArray(analysis.warnings) || analysis.warnings.some((warning) => typeof warning !== "string")) throw new Error("experiment decision analysis summary is invalid");
    if (!object(analysis.by_task_type)) throw new Error("experiment decision task-type analysis is invalid");
    validateAnalysisScope(analysis, "global", protocol);
    const expectedChecks: ExperimentDecisionCheck[] = [];
    scopeChecks(expectedChecks, "global", analysis, protocol);
    for (const taskType of [...(protocol.required_task_types || [])].sort()) {
      const slice = analysis.by_task_type[taskType];
      if (slice !== undefined) validateAnalysisScope(slice, `task_type:${taskType}`, protocol);
      scopeChecks(expectedChecks, `task_type:${taskType}`, slice, protocol);
    }
    if (canonicalJson(typedChecks) !== canonicalJson(expectedChecks)) throw new Error("experiment decision checks are inconsistent with analysis");
  }
  return value as unknown as ExperimentDecision;
}
