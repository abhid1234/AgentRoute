import { foldRouteRecords } from "./route.js";
import { ROUTE_VERSION } from "./route-types.js";
import type { RouteRecord, RouteState } from "./route-types.js";

export type DriftStatus = "pass" | "fail" | "insufficient";

export interface RoutingDriftConfig {
  minimum_baseline_samples?: number;
  minimum_current_samples?: number;
  minimum_observation_coverage?: number;
  maximum_total_variation?: number;
  maximum_selection_share_change?: number;
  maximum_failure_rate_increase?: number;
  maximum_mean_latency_increase_percent?: number;
  maximum_mean_cost_increase_percent?: number;
  minimum_mean_quality_delta?: number;
  include_task_slices?: boolean;
}

export interface RoutingIdentityShare {
  identity: string;
  model: string;
  provider?: string;
  baseline_count: number;
  current_count: number;
  baseline_share: number;
  current_share: number;
  share_delta: number;
}

export interface DriftMetrics {
  samples: number;
  observed: number;
  observation_coverage: number;
  failure_rate?: number;
  mean_latency_ms?: number;
  mean_cost_usd?: number;
  mean_quality?: number;
}

export interface RoutingDriftSlice {
  scope: string;
  baseline: DriftMetrics;
  current: DriftMetrics;
  total_variation: number;
  maximum_selection_share_change: number;
  selection_distribution: RoutingIdentityShare[];
  newly_selected: string[];
  no_longer_selected: string[];
  deltas: {
    failure_rate?: number;
    mean_latency_percent?: number;
    mean_cost_percent?: number;
    mean_quality?: number;
  };
}

export interface RoutingDriftCheck {
  scope: string;
  metric: string;
  status: DriftStatus;
  actual?: number;
  threshold?: number;
  detail: string;
}

export interface RoutingDriftReport {
  route_version: string;
  drift_version: "0.1";
  generated_at: string;
  status: DriftStatus;
  config: Required<RoutingDriftConfig>;
  global: RoutingDriftSlice;
  by_task_type: Record<string, RoutingDriftSlice>;
  checks: RoutingDriftCheck[];
  warnings: string[];
}

const DEFAULT_CONFIG: Required<RoutingDriftConfig> = {
  minimum_baseline_samples: 1,
  minimum_current_samples: 1,
  minimum_observation_coverage: 0,
  maximum_total_variation: 1,
  maximum_selection_share_change: 1,
  maximum_failure_rate_increase: 1,
  maximum_mean_latency_increase_percent: Number.MAX_SAFE_INTEGER,
  maximum_mean_cost_increase_percent: Number.MAX_SAFE_INTEGER,
  minimum_mean_quality_delta: -1,
  include_task_slices: true,
};

const CONFIG_KEYS = new Set(Object.keys(DEFAULT_CONFIG));
const rounded = (value: number, digits = 6): number => Number(value.toFixed(digits));
const mean = (values: number[]): number | undefined => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;

function validateConfig(value: RoutingDriftConfig): Required<RoutingDriftConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("drift config must be an object");
  const unknown = Object.keys(value).filter((key) => !CONFIG_KEYS.has(key));
  if (unknown.length) throw new Error(`drift config contains unknown keys: ${unknown.sort().join(", ")}`);
  const config = { ...DEFAULT_CONFIG, ...value };
  for (const key of ["minimum_baseline_samples", "minimum_current_samples"] as const) {
    if (!Number.isInteger(config[key]) || config[key] < 1) throw new Error(`drift config.${key} must be an integer >= 1`);
  }
  for (const key of ["minimum_observation_coverage", "maximum_total_variation", "maximum_selection_share_change", "maximum_failure_rate_increase"] as const) {
    if (!Number.isFinite(config[key]) || config[key] < 0 || config[key] > 1) throw new Error(`drift config.${key} must be in the range 0..1`);
  }
  for (const key of ["maximum_mean_latency_increase_percent", "maximum_mean_cost_increase_percent"] as const) {
    if (!Number.isFinite(config[key]) || config[key] < 0) throw new Error(`drift config.${key} must be a finite number >= 0`);
  }
  if (!Number.isFinite(config.minimum_mean_quality_delta) || config.minimum_mean_quality_delta < -1 || config.minimum_mean_quality_delta > 1) {
    throw new Error("drift config.minimum_mean_quality_delta must be in the range -1..1");
  }
  if (typeof config.include_task_slices !== "boolean") throw new Error("drift config.include_task_slices must be boolean");
  return config;
}

function identityFor(state: RouteState): { identity: string; model: string; provider?: string } {
  const candidate = state.decision.candidates.find((item) => item.id === state.decision.selection.candidate_id)!;
  return {
    identity: candidate.provider ? `${candidate.provider}/${candidate.model}` : candidate.model,
    model: candidate.model,
    ...(candidate.provider ? { provider: candidate.provider } : {}),
  };
}

function metrics(states: RouteState[]): DriftMetrics {
  const outcomes = states.flatMap((state) => state.latest_observation ? [state.latest_observation.outcome] : []);
  const numeric = (key: "latency_ms" | "cost_usd" | "quality"): number[] => outcomes
    .map((outcome) => outcome[key])
    .filter((value): value is number => value !== undefined);
  const result: DriftMetrics = {
    samples: states.length,
    observed: outcomes.length,
    observation_coverage: rounded(states.length ? outcomes.length / states.length : 0),
  };
  if (outcomes.length) result.failure_rate = rounded(outcomes.filter((outcome) => outcome.status === "failure").length / outcomes.length);
  const latency = mean(numeric("latency_ms"));
  const cost = mean(numeric("cost_usd"));
  const quality = mean(numeric("quality"));
  if (latency !== undefined) result.mean_latency_ms = rounded(latency);
  if (cost !== undefined) result.mean_cost_usd = rounded(cost);
  if (quality !== undefined) result.mean_quality = rounded(quality);
  return result;
}

function percentChange(baseline: number | undefined, current: number | undefined): number | undefined {
  if (baseline === undefined || current === undefined) return undefined;
  if (baseline === 0) return current === 0 ? 0 : undefined;
  return rounded(((current - baseline) / baseline) * 100);
}

function analyzeSlice(scope: string, baselineStates: RouteState[], currentStates: RouteState[]): RoutingDriftSlice {
  const baselineCounts = new Map<string, { count: number; model: string; provider?: string }>();
  const currentCounts = new Map<string, { count: number; model: string; provider?: string }>();
  for (const [states, bucket] of [[baselineStates, baselineCounts], [currentStates, currentCounts]] as const) {
    for (const state of states) {
      const identity = identityFor(state);
      const previous = bucket.get(identity.identity);
      bucket.set(identity.identity, { count: (previous?.count || 0) + 1, model: identity.model, ...(identity.provider ? { provider: identity.provider } : {}) });
    }
  }
  const identities = [...new Set([...baselineCounts.keys(), ...currentCounts.keys()])].sort();
  const selectionDistribution = identities.map((identity): RoutingIdentityShare => {
    const source = baselineCounts.get(identity) || currentCounts.get(identity)!;
    const baselineCount = baselineCounts.get(identity)?.count || 0;
    const currentCount = currentCounts.get(identity)?.count || 0;
    const baselineShare = baselineStates.length ? baselineCount / baselineStates.length : 0;
    const currentShare = currentStates.length ? currentCount / currentStates.length : 0;
    return {
      identity,
      model: source.model,
      ...(source.provider ? { provider: source.provider } : {}),
      baseline_count: baselineCount,
      current_count: currentCount,
      baseline_share: rounded(baselineShare),
      current_share: rounded(currentShare),
      share_delta: rounded(currentShare - baselineShare),
    };
  });
  const baselineMetrics = metrics(baselineStates);
  const currentMetrics = metrics(currentStates);
  const failureDelta = baselineMetrics.failure_rate !== undefined && currentMetrics.failure_rate !== undefined
    ? rounded(currentMetrics.failure_rate - baselineMetrics.failure_rate) : undefined;
  const qualityDelta = baselineMetrics.mean_quality !== undefined && currentMetrics.mean_quality !== undefined
    ? rounded(currentMetrics.mean_quality - baselineMetrics.mean_quality) : undefined;
  return {
    scope,
    baseline: baselineMetrics,
    current: currentMetrics,
    total_variation: rounded(selectionDistribution.reduce((sum, item) => sum + Math.abs(item.share_delta), 0) / 2),
    maximum_selection_share_change: rounded(Math.max(0, ...selectionDistribution.map((item) => Math.abs(item.share_delta)))),
    selection_distribution: selectionDistribution,
    newly_selected: identities.filter((identity) => !baselineCounts.has(identity) && currentCounts.has(identity)),
    no_longer_selected: identities.filter((identity) => baselineCounts.has(identity) && !currentCounts.has(identity)),
    deltas: {
      ...(failureDelta !== undefined ? { failure_rate: failureDelta } : {}),
      ...(percentChange(baselineMetrics.mean_latency_ms, currentMetrics.mean_latency_ms) !== undefined ? { mean_latency_percent: percentChange(baselineMetrics.mean_latency_ms, currentMetrics.mean_latency_ms)! } : {}),
      ...(percentChange(baselineMetrics.mean_cost_usd, currentMetrics.mean_cost_usd) !== undefined ? { mean_cost_percent: percentChange(baselineMetrics.mean_cost_usd, currentMetrics.mean_cost_usd)! } : {}),
      ...(qualityDelta !== undefined ? { mean_quality: qualityDelta } : {}),
    },
  };
}

function checksFor(slice: RoutingDriftSlice, config: Required<RoutingDriftConfig>): RoutingDriftCheck[] {
  const checks: RoutingDriftCheck[] = [];
  const enoughSamples = slice.baseline.samples >= config.minimum_baseline_samples && slice.current.samples >= config.minimum_current_samples;
  const add = (metric: string, status: DriftStatus, detail: string, actual?: number, threshold?: number): void => {
    checks.push({ scope: slice.scope, metric, status, ...(actual !== undefined ? { actual } : {}), ...(threshold !== undefined ? { threshold } : {}), detail });
  };
  add("baseline_samples", slice.baseline.samples >= config.minimum_baseline_samples ? "pass" : "insufficient", `${slice.baseline.samples} baseline samples; requires ${config.minimum_baseline_samples}`, slice.baseline.samples, config.minimum_baseline_samples);
  add("current_samples", slice.current.samples >= config.minimum_current_samples ? "pass" : "insufficient", `${slice.current.samples} current samples; requires ${config.minimum_current_samples}`, slice.current.samples, config.minimum_current_samples);
  const distribution = (metric: string, actual: number, threshold: number): void => {
    const status: DriftStatus = !enoughSamples ? "insufficient" : actual <= threshold ? "pass" : "fail";
    add(metric, status, `${actual} must be <= ${threshold}`, actual, threshold);
  };
  distribution("total_variation", slice.total_variation, config.maximum_total_variation);
  distribution("maximum_selection_share_change", slice.maximum_selection_share_change, config.maximum_selection_share_change);

  const enoughOutcomes = enoughSamples
    && slice.baseline.observation_coverage >= config.minimum_observation_coverage
    && slice.current.observation_coverage >= config.minimum_observation_coverage;
  for (const side of ["baseline", "current"] as const) {
    const actual = slice[side].observation_coverage;
    add(`${side}_observation_coverage`, actual >= config.minimum_observation_coverage ? "pass" : "insufficient", `${actual} must be >= ${config.minimum_observation_coverage}`, actual, config.minimum_observation_coverage);
  }
  const outcome = (metric: string, actual: number | undefined, threshold: number, direction: "maximum" | "minimum"): void => {
    if (!enoughOutcomes || actual === undefined) {
      add(metric, "insufficient", `${metric} requires measured baseline and current evidence`, actual, threshold);
      return;
    }
    const passed = direction === "maximum" ? actual <= threshold : actual >= threshold;
    add(metric, passed ? "pass" : "fail", `${actual} must be ${direction === "maximum" ? "<=" : ">="} ${threshold}`, actual, threshold);
  };
  outcome("failure_rate_increase", slice.deltas.failure_rate, config.maximum_failure_rate_increase, "maximum");
  outcome("mean_latency_increase_percent", slice.deltas.mean_latency_percent, config.maximum_mean_latency_increase_percent, "maximum");
  outcome("mean_cost_increase_percent", slice.deltas.mean_cost_percent, config.maximum_mean_cost_increase_percent, "maximum");
  outcome("mean_quality_delta", slice.deltas.mean_quality, config.minimum_mean_quality_delta, "minimum");
  return checks;
}

export function evaluateRoutingDrift(
  baselineRecords: RouteRecord[],
  currentRecords: RouteRecord[],
  inputConfig: RoutingDriftConfig,
  generatedAt = new Date().toISOString(),
): RoutingDriftReport {
  if (Number.isNaN(Date.parse(generatedAt))) throw new Error("drift generated_at must be an ISO-8601 timestamp");
  const config = validateConfig(inputConfig);
  const baseline = [...foldRouteRecords(baselineRecords).values()];
  const current = [...foldRouteRecords(currentRecords).values()];
  const global = analyzeSlice("global", baseline, current);
  const byTaskType: Record<string, RoutingDriftSlice> = {};
  if (config.include_task_slices) {
    const taskTypes = [...new Set([...baseline, ...current].map((state) => state.decision.task.type))].sort();
    for (const taskType of taskTypes) {
      byTaskType[taskType] = analyzeSlice(
        `task:${taskType}`,
        baseline.filter((state) => state.decision.task.type === taskType),
        current.filter((state) => state.decision.task.type === taskType),
      );
    }
  }
  const slices = [global, ...Object.values(byTaskType)];
  const checks = slices.flatMap((slice) => checksFor(slice, config));
  const status: DriftStatus = checks.some((check) => check.status === "fail") ? "fail"
    : checks.some((check) => check.status === "insufficient") ? "insufficient" : "pass";
  const warnings = slices.flatMap((slice) => {
    const result: string[] = [];
    if (slice.baseline.samples === 0 || slice.current.samples === 0) result.push(`${slice.scope}: one comparison side has no decisions`);
    if (slice.deltas.mean_latency_percent === undefined) result.push(`${slice.scope}: latency percent delta unavailable because evidence is missing or the baseline mean is zero`);
    if (slice.deltas.mean_cost_percent === undefined) result.push(`${slice.scope}: cost percent delta unavailable because evidence is missing or the baseline mean is zero`);
    return result;
  });
  return {
    route_version: ROUTE_VERSION,
    drift_version: "0.1",
    generated_at: generatedAt,
    status,
    config,
    global,
    by_task_type: byTaskType,
    checks,
    warnings,
  };
}
