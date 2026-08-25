import type { RouteRecord } from "./route-types.js";
import { foldRouteRecords, policyViolations } from "./route.js";

export interface RouteGateConfig {
  minimum_samples?: number;
  minimum_observation_coverage?: number;
  maximum_cost_increase_percent?: number;
  maximum_latency_increase_percent?: number;
  minimum_quality_delta?: number;
  maximum_policy_violations?: number;
  insufficient_evidence?: "fail" | "neutral";
  task_type_slices?: boolean;
}

export interface RouteGateMetric {
  id: string;
  status: "pass" | "fail" | "neutral";
  message: string;
  baseline?: number;
  current?: number;
  threshold?: number;
  slice?: string;
}

export interface RouteGateSliceResult {
  status: "pass" | "fail" | "neutral";
  baseline_samples: number;
  current_samples: number;
}

export interface RouteGateResult {
  gate_version: "0.1";
  status: "pass" | "fail" | "neutral";
  baseline_samples: number;
  current_samples: number;
  metrics: RouteGateMetric[];
  slices?: Record<string, RouteGateSliceResult>;
}

interface Aggregates {
  samples: number;
  coverage: number;
  mean_cost?: number;
  mean_latency?: number;
  mean_quality?: number;
  violations: number;
}

const mean = (values: number[]): number | undefined => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
const round = (value: number): number => Number(value.toFixed(6));

function aggregates(records: RouteRecord[], taskType?: string): Aggregates {
  const states = [...foldRouteRecords(records).values()].filter((state) => !taskType || state.decision.task.type === taskType);
  const outcomes = states.flatMap((state) => state.latest_observation ? [state.latest_observation.outcome] : []);
  const metric = (key: "cost_usd" | "latency_ms" | "quality"): number[] => outcomes.map((outcome) => outcome[key]).filter((value): value is number => value !== undefined);
  return {
    samples: outcomes.length,
    coverage: states.length ? outcomes.length / states.length : 0,
    ...(mean(metric("cost_usd")) !== undefined ? { mean_cost: round(mean(metric("cost_usd"))!) } : {}),
    ...(mean(metric("latency_ms")) !== undefined ? { mean_latency: round(mean(metric("latency_ms"))!) } : {}),
    ...(mean(metric("quality")) !== undefined ? { mean_quality: round(mean(metric("quality"))!) } : {}),
    violations: states.filter((state) => policyViolations(state.decision).length > 0).length,
  };
}

function validateConfig(config: RouteGateConfig): void {
  const nonNegative = ["minimum_samples", "maximum_cost_increase_percent", "maximum_latency_increase_percent", "maximum_policy_violations"] as const;
  for (const key of nonNegative) if (config[key] !== undefined && (!Number.isFinite(config[key]) || config[key]! < 0)) throw new Error(`${key} must be non-negative`);
  if (config.minimum_samples !== undefined && !Number.isInteger(config.minimum_samples)) throw new Error("minimum_samples must be an integer");
  if (config.minimum_observation_coverage !== undefined && (!Number.isFinite(config.minimum_observation_coverage) || config.minimum_observation_coverage < 0 || config.minimum_observation_coverage > 1)) throw new Error("minimum_observation_coverage is invalid");
  if (config.minimum_quality_delta !== undefined && (!Number.isFinite(config.minimum_quality_delta) || config.minimum_quality_delta < -1 || config.minimum_quality_delta > 1)) throw new Error("minimum_quality_delta must be -1..1");
  if (config.insufficient_evidence && !["fail", "neutral"].includes(config.insufficient_evidence)) throw new Error("insufficient_evidence must be fail or neutral");
  if (config.task_type_slices !== undefined && typeof config.task_type_slices !== "boolean") throw new Error("task_type_slices must be boolean");
}

function gateMetrics(baseline: Aggregates, current: Aggregates, config: RouteGateConfig, slice?: string): RouteGateMetric[] {
  const metrics: RouteGateMetric[] = [];
  const insufficientStatus = config.insufficient_evidence === "neutral" ? "neutral" : "fail";
  const decorate = (metric: RouteGateMetric): RouteGateMetric => slice ? { ...metric, slice } : metric;
  const addEvidence = (id: string, message: string): void => { metrics.push(decorate({ id, status: insufficientStatus, message })); };
  const requiredSamples = config.minimum_samples ?? 1;
  const sampleMetric = (id: string, label: string, samples: number): void => {
    if (samples < requiredSamples) addEvidence(id, `${label} has ${samples} measured samples; ${requiredSamples} required`);
    else metrics.push(decorate({ id, status: "pass", message: `${label} has ${samples} measured samples; ${requiredSamples} required`, current: samples, threshold: requiredSamples }));
  };
  sampleMetric("baseline_samples", "baseline", baseline.samples);
  sampleMetric("current_samples", "current", current.samples);
  if (config.minimum_observation_coverage !== undefined) metrics.push(decorate({
    id: "observation_coverage",
    status: current.coverage >= config.minimum_observation_coverage ? "pass" : "fail",
    message: `current observation coverage ${current.coverage}; minimum ${config.minimum_observation_coverage}`,
    current: current.coverage,
    threshold: config.minimum_observation_coverage,
  }));
  const relative = (id: string, label: string, base: number | undefined, value: number | undefined, allowed: number | undefined): void => {
    if (allowed === undefined) return;
    if (base === undefined || value === undefined) return addEvidence(id, `${label} comparison lacks measured evidence`);
    const increase = base === 0 ? (value === 0 ? 0 : Number.POSITIVE_INFINITY) : ((value - base) / base) * 100;
    metrics.push(decorate({ id, status: increase <= allowed ? "pass" : "fail", message: `${label} changed ${Number.isFinite(increase) ? round(increase) + "%" : "from zero to non-zero"}; maximum increase ${allowed}%`, baseline: base, current: value, threshold: allowed }));
  };
  relative("mean_cost", "mean cost", baseline.mean_cost, current.mean_cost, config.maximum_cost_increase_percent);
  relative("mean_latency", "mean latency", baseline.mean_latency, current.mean_latency, config.maximum_latency_increase_percent);
  if (config.minimum_quality_delta !== undefined) {
    if (baseline.mean_quality === undefined || current.mean_quality === undefined) addEvidence("mean_quality", "quality comparison lacks measured evidence");
    else {
      const delta = round(current.mean_quality - baseline.mean_quality);
      metrics.push(decorate({ id: "mean_quality", status: delta >= config.minimum_quality_delta ? "pass" : "fail", message: `mean quality delta ${delta}; minimum ${config.minimum_quality_delta}`, baseline: baseline.mean_quality, current: current.mean_quality, threshold: config.minimum_quality_delta }));
    }
  }
  if (config.maximum_policy_violations !== undefined) metrics.push(decorate({
    id: "policy_violations",
    status: current.violations <= config.maximum_policy_violations ? "pass" : "fail",
    message: `current policy violations ${current.violations}; maximum ${config.maximum_policy_violations}`,
    current: current.violations,
    threshold: config.maximum_policy_violations,
  }));
  return metrics;
}

function gateStatus(metrics: RouteGateMetric[]): "pass" | "fail" | "neutral" {
  return metrics.some((metric) => metric.status === "fail") ? "fail" : metrics.some((metric) => metric.status === "neutral") ? "neutral" : "pass";
}

export function evaluateRouteGate(baselineRecords: RouteRecord[], currentRecords: RouteRecord[], config: RouteGateConfig): RouteGateResult {
  validateConfig(config);
  const baseline = aggregates(baselineRecords);
  const current = aggregates(currentRecords);
  const metrics = gateMetrics(baseline, current, config);
  const slices: Record<string, RouteGateSliceResult> = {};
  if (config.task_type_slices) {
    const taskTypes = new Set<string>();
    for (const state of foldRouteRecords(baselineRecords).values()) taskTypes.add(state.decision.task.type);
    for (const state of foldRouteRecords(currentRecords).values()) taskTypes.add(state.decision.task.type);
    for (const taskType of [...taskTypes].sort()) {
      const sliceBaseline = aggregates(baselineRecords, taskType);
      const sliceCurrent = aggregates(currentRecords, taskType);
      const sliceMetrics = gateMetrics(sliceBaseline, sliceCurrent, config, `task_type:${taskType}`);
      metrics.push(...sliceMetrics);
      slices[taskType] = { status: gateStatus(sliceMetrics), baseline_samples: sliceBaseline.samples, current_samples: sliceCurrent.samples };
    }
  }
  return { gate_version: "0.1", status: gateStatus(metrics), baseline_samples: baseline.samples, current_samples: current.samples, metrics, ...(config.task_type_slices ? { slices } : {}) };
}

export function formatGitHubGate(result: RouteGateResult): string {
  const prefix = result.status === "fail" ? "::error" : result.status === "neutral" ? "::warning" : "::notice";
  const lines = [`${prefix} title=AgentRoute quality gate::${result.status.toUpperCase()} (${result.current_samples} current samples)`];
  for (const metric of result.metrics) lines.push(`- [${metric.status.toUpperCase()}]${metric.slice ? ` [${metric.slice}]` : ""} ${metric.message}`);
  return lines.join("\n");
}
