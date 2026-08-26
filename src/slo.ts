import { foldRouteRecords, policyViolations } from "./route.js";
import { ROUTE_VERSION } from "./route-types.js";
import type { RouteRecord, RouteState } from "./route-types.js";

export type RoutingSloStatus = "pass" | "fail" | "insufficient";

export interface RoutingSloObjectives {
  minimum_success_rate?: number;
  maximum_p95_latency_ms?: number;
  maximum_p95_cost_usd?: number;
  minimum_p10_quality?: number;
  maximum_policy_violation_rate?: number;
}

export interface RoutingSloConfig {
  slo_version: "0.1";
  id: string;
  minimum_samples: number;
  minimum_slice_samples?: number;
  minimum_observation_coverage: number;
  minimum_measurement_coverage: number;
  include_task_slices?: boolean;
  objectives: RoutingSloObjectives;
}

export interface RoutingErrorBudget {
  target_success_rate: number;
  observed_outcomes: number;
  unsuccessful_outcomes: number;
  allowed_unsuccessful_outcomes: number;
  consumed: number;
  remaining: number;
  exhausted: boolean;
  burn_ratio?: number;
}

export interface RoutingSloSlice {
  scope: string;
  samples: number;
  observed: number;
  observation_coverage: number;
  successful_outcomes: number;
  success_rate?: number;
  latency_measurements: number;
  latency_coverage: number;
  p95_latency_ms?: number;
  cost_measurements: number;
  cost_coverage: number;
  p95_cost_usd?: number;
  quality_measurements: number;
  quality_coverage: number;
  p10_quality?: number;
  policy_violations: number;
  policy_violation_rate: number;
  error_budget?: RoutingErrorBudget;
}

export interface RoutingSloCheck {
  scope: string;
  metric: string;
  status: RoutingSloStatus;
  actual?: number;
  threshold: number;
  comparison: ">=" | "<=";
  detail: string;
}

export interface RoutingSloReport {
  route_version: string;
  slo_report_version: "0.1";
  generated_at: string;
  status: RoutingSloStatus;
  config: Required<Omit<RoutingSloConfig, "objectives">> & { objectives: RoutingSloObjectives };
  global: RoutingSloSlice;
  by_task_type: Record<string, RoutingSloSlice>;
  checks: RoutingSloCheck[];
  warnings: string[];
}

const CONFIG_KEYS = new Set(["slo_version", "id", "minimum_samples", "minimum_slice_samples", "minimum_observation_coverage", "minimum_measurement_coverage", "include_task_slices", "objectives"]);
const OBJECTIVE_KEYS = new Set(["minimum_success_rate", "maximum_p95_latency_ms", "maximum_p95_cost_usd", "minimum_p10_quality", "maximum_policy_violation_rate"]);
const rounded = (value: number, digits = 6): number => Number(value.toFixed(digits));

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function rejectUnknown(value: Record<string, unknown>, keys: Set<string>, label: string): void {
  const unknown = Object.keys(value).filter((key) => !keys.has(key));
  if (unknown.length) throw new Error(`${label} contains unknown keys: ${unknown.sort().join(", ")}`);
}

export function validateRoutingSloConfig(value: unknown): RoutingSloReport["config"] {
  assertObject(value, "SLO config");
  rejectUnknown(value, CONFIG_KEYS, "SLO config");
  if (value.slo_version !== "0.1") throw new Error("SLO config.slo_version must be 0.1");
  if (typeof value.id !== "string" || !value.id) throw new Error("SLO config.id must be a non-empty string");
  for (const key of ["minimum_samples"] as const) {
    if (!Number.isInteger(value[key]) || (value[key] as number) < 1) throw new Error(`SLO config.${key} must be an integer >= 1`);
  }
  const minimumSliceSamples = value.minimum_slice_samples === undefined ? value.minimum_samples as number : value.minimum_slice_samples;
  if (!Number.isInteger(minimumSliceSamples) || (minimumSliceSamples as number) < 1) throw new Error("SLO config.minimum_slice_samples must be an integer >= 1");
  for (const key of ["minimum_observation_coverage", "minimum_measurement_coverage"] as const) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] < 0 || value[key] > 1) throw new Error(`SLO config.${key} must be in the range 0..1`);
  }
  if (value.include_task_slices !== undefined && typeof value.include_task_slices !== "boolean") throw new Error("SLO config.include_task_slices must be boolean");
  assertObject(value.objectives, "SLO config.objectives");
  rejectUnknown(value.objectives, OBJECTIVE_KEYS, "SLO config.objectives");
  if (!Object.keys(value.objectives).length) throw new Error("SLO config.objectives requires at least one objective");
  for (const key of ["minimum_success_rate", "minimum_p10_quality", "maximum_policy_violation_rate"] as const) {
    const item = value.objectives[key];
    if (item !== undefined && (typeof item !== "number" || !Number.isFinite(item) || item < 0 || item > 1)) throw new Error(`SLO config.objectives.${key} must be in the range 0..1`);
  }
  for (const key of ["maximum_p95_latency_ms", "maximum_p95_cost_usd"] as const) {
    const item = value.objectives[key];
    if (item !== undefined && (typeof item !== "number" || !Number.isFinite(item) || item < 0)) throw new Error(`SLO config.objectives.${key} must be a finite number >= 0`);
  }
  return {
    slo_version: "0.1",
    id: value.id,
    minimum_samples: value.minimum_samples as number,
    minimum_slice_samples: minimumSliceSamples as number,
    minimum_observation_coverage: value.minimum_observation_coverage as number,
    minimum_measurement_coverage: value.minimum_measurement_coverage as number,
    include_task_slices: value.include_task_slices === undefined ? true : value.include_task_slices,
    objectives: { ...value.objectives } as RoutingSloObjectives,
  };
}

function nearestRank(values: number[], percentile: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)];
}

function analyzeSlice(scope: string, states: RouteState[], successTarget: number | undefined): RoutingSloSlice {
  const outcomes = states.flatMap((state) => state.latest_observation ? [state.latest_observation.outcome] : []);
  const values = (key: "latency_ms" | "cost_usd" | "quality"): number[] => outcomes.map((outcome) => outcome[key]).filter((item): item is number => item !== undefined);
  const latency = values("latency_ms");
  const cost = values("cost_usd");
  const quality = values("quality");
  const successful = outcomes.filter((outcome) => outcome.status === "success").length;
  const violations = states.filter((state) => policyViolations(state.decision).length > 0).length;
  const samples = states.length;
  const unsuccessful = outcomes.length - successful;
  const allowed = successTarget === undefined ? undefined : outcomes.length * (1 - successTarget);
  const errorBudget: RoutingErrorBudget | undefined = successTarget === undefined ? undefined : {
    target_success_rate: successTarget,
    observed_outcomes: outcomes.length,
    unsuccessful_outcomes: unsuccessful,
    allowed_unsuccessful_outcomes: rounded(allowed!),
    consumed: unsuccessful,
    remaining: rounded(allowed! - unsuccessful),
    exhausted: unsuccessful > allowed! + 1e-12,
    ...(allowed! > 0 ? { burn_ratio: rounded(unsuccessful / allowed!) } : unsuccessful === 0 ? { burn_ratio: 0 } : {}),
  };
  return {
    scope,
    samples,
    observed: outcomes.length,
    observation_coverage: rounded(samples ? outcomes.length / samples : 0),
    successful_outcomes: successful,
    ...(outcomes.length ? { success_rate: rounded(successful / outcomes.length) } : {}),
    latency_measurements: latency.length,
    latency_coverage: rounded(samples ? latency.length / samples : 0),
    ...(nearestRank(latency, 0.95) !== undefined ? { p95_latency_ms: rounded(nearestRank(latency, 0.95)!) } : {}),
    cost_measurements: cost.length,
    cost_coverage: rounded(samples ? cost.length / samples : 0),
    ...(nearestRank(cost, 0.95) !== undefined ? { p95_cost_usd: rounded(nearestRank(cost, 0.95)!) } : {}),
    quality_measurements: quality.length,
    quality_coverage: rounded(samples ? quality.length / samples : 0),
    ...(nearestRank(quality, 0.10) !== undefined ? { p10_quality: rounded(nearestRank(quality, 0.10)!) } : {}),
    policy_violations: violations,
    policy_violation_rate: rounded(samples ? violations / samples : 0),
    ...(errorBudget ? { error_budget: errorBudget } : {}),
  };
}

function checksFor(slice: RoutingSloSlice, config: RoutingSloReport["config"], minimumSamples: number): RoutingSloCheck[] {
  const checks: RoutingSloCheck[] = [];
  const add = (metric: string, status: RoutingSloStatus, actual: number | undefined, threshold: number, comparison: ">=" | "<=", detail: string): void => {
    checks.push({ scope: slice.scope, metric, status, ...(actual !== undefined ? { actual } : {}), threshold, comparison, detail });
  };
  const enoughSamples = slice.samples >= minimumSamples;
  add("samples", enoughSamples ? "pass" : "insufficient", slice.samples, minimumSamples, ">=", `${slice.samples} samples; requires ${minimumSamples}`);
  const enoughObservations = enoughSamples && slice.observation_coverage >= config.minimum_observation_coverage;
  add("observation_coverage", enoughObservations ? "pass" : "insufficient", slice.observation_coverage, config.minimum_observation_coverage, ">=", `${slice.observation_coverage} must be >= ${config.minimum_observation_coverage}`);
  const objective = (metric: string, actual: number | undefined, threshold: number, comparison: ">=" | "<=", evidenceReady: boolean): void => {
    if (!evidenceReady || actual === undefined) {
      add(metric, "insufficient", actual, threshold, comparison, `${metric} lacks the configured sample or measurement coverage`);
      return;
    }
    const passed = comparison === ">=" ? actual >= threshold : actual <= threshold;
    add(metric, passed ? "pass" : "fail", actual, threshold, comparison, `${actual} must be ${comparison} ${threshold}`);
  };
  const objectives = config.objectives;
  if (objectives.minimum_success_rate !== undefined) objective("success_rate", slice.success_rate, objectives.minimum_success_rate, ">=", enoughObservations);
  if (objectives.maximum_p95_latency_ms !== undefined) objective("p95_latency_ms", slice.p95_latency_ms, objectives.maximum_p95_latency_ms, "<=", enoughSamples && slice.latency_coverage >= config.minimum_measurement_coverage);
  if (objectives.maximum_p95_cost_usd !== undefined) objective("p95_cost_usd", slice.p95_cost_usd, objectives.maximum_p95_cost_usd, "<=", enoughSamples && slice.cost_coverage >= config.minimum_measurement_coverage);
  if (objectives.minimum_p10_quality !== undefined) objective("p10_quality", slice.p10_quality, objectives.minimum_p10_quality, ">=", enoughSamples && slice.quality_coverage >= config.minimum_measurement_coverage);
  if (objectives.maximum_policy_violation_rate !== undefined) objective("policy_violation_rate", slice.policy_violation_rate, objectives.maximum_policy_violation_rate, "<=", enoughSamples);
  return checks;
}

export function evaluateRoutingSlo(records: RouteRecord[], inputConfig: unknown, generatedAt = new Date().toISOString()): RoutingSloReport {
  if (Number.isNaN(Date.parse(generatedAt))) throw new Error("SLO generated_at must be an ISO-8601 timestamp");
  const config = validateRoutingSloConfig(inputConfig);
  const states = [...foldRouteRecords(records).values()];
  const global = analyzeSlice("global", states, config.objectives.minimum_success_rate);
  const byTaskType: Record<string, RoutingSloSlice> = {};
  if (config.include_task_slices) {
    for (const taskType of [...new Set(states.map((state) => state.decision.task.type))].sort()) {
      byTaskType[taskType] = analyzeSlice(`task:${taskType}`, states.filter((state) => state.decision.task.type === taskType), config.objectives.minimum_success_rate);
    }
  }
  const checks = [...checksFor(global, config, config.minimum_samples), ...Object.values(byTaskType).flatMap((slice) => checksFor(slice, config, config.minimum_slice_samples))];
  const status: RoutingSloStatus = checks.some((check) => check.status === "fail") ? "fail"
    : checks.some((check) => check.status === "insufficient") ? "insufficient" : "pass";
  const warnings = [global, ...Object.values(byTaskType)].flatMap((slice) => {
    const result: string[] = [];
    if (config.objectives.maximum_p95_latency_ms !== undefined && slice.latency_coverage < config.minimum_measurement_coverage) result.push(`${slice.scope}: latency measurement coverage is below the configured floor`);
    if (config.objectives.maximum_p95_cost_usd !== undefined && slice.cost_coverage < config.minimum_measurement_coverage) result.push(`${slice.scope}: cost measurement coverage is below the configured floor`);
    if (config.objectives.minimum_p10_quality !== undefined && slice.quality_coverage < config.minimum_measurement_coverage) result.push(`${slice.scope}: quality measurement coverage is below the configured floor`);
    if (slice.error_budget?.exhausted) result.push(`${slice.scope}: successful-outcome error budget is exhausted`);
    return result;
  });
  return {
    route_version: ROUTE_VERSION,
    slo_report_version: "0.1",
    generated_at: generatedAt,
    status,
    config,
    global,
    by_task_type: byTaskType,
    checks,
    warnings,
  };
}
