import type { RouteOutcome, RouteRecord, RouteState } from "./route-types.js";
import { foldRouteRecords } from "./route.js";

export interface ExperimentAnalysisOptions {
  baseline_candidate_id?: string;
  challenger_candidate_ids?: string[];
  quality_tie_tolerance?: number;
  generated_at?: string;
}

export interface ExperimentCandidateStats {
  candidate_id: string;
  model: string;
  provider?: string;
  samples: number;
  successes: number;
  success_rate: number;
  mean_quality?: number;
  mean_latency_ms?: number;
  mean_cost_usd?: number;
}

export interface ExperimentPairwiseComparison {
  baseline_candidate_id: string;
  challenger_candidate_id: string;
  matched_pairs: number;
  quality_pairs: number;
  challenger_quality_wins: number;
  challenger_quality_losses: number;
  quality_ties: number;
  challenger_quality_win_rate?: number;
  challenger_quality_win_rate_95ci?: { low: number; high: number };
  mean_quality_delta?: number;
  mean_latency_delta_ms?: number;
  mean_cost_delta_usd?: number;
}

export interface ExperimentSliceReport {
  samples: number;
  paired_units: number;
  candidates: ExperimentCandidateStats[];
  comparisons: ExperimentPairwiseComparison[];
}

export interface ReplayExperimentReport extends ExperimentSliceReport {
  experiment_version: "0.1";
  generated_at: string;
  arena_runs: number;
  by_task_type: Record<string, ExperimentSliceReport>;
  warnings: string[];
}

interface ExperimentSample {
  unit_id: string;
  arena_run_id: string;
  original_route_id: string;
  task_type: string;
  candidate_id: string;
  model: string;
  provider?: string;
  outcome: RouteOutcome;
}

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;
const round = (value: number): number => Number(value.toFixed(6));
const mean = (values: number[]): number | undefined => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;

function metric(outcomes: RouteOutcome[], key: "quality" | "latency_ms" | "cost_usd"): number[] {
  return outcomes.map((outcome) => outcome[key]).filter((value): value is number => value !== undefined);
}

function replaySample(state: RouteState, warnings: string[]): ExperimentSample | undefined {
  if (state.decision.router.name !== "agentroute-replay-arena") return undefined;
  const metadata = object(state.decision.extensions);
  const arenaRunId = string(metadata.arena_run_id);
  const originalRouteId = string(metadata.original_route_id) || state.decision.context?.parent_route_id;
  const originalCandidateId = string(metadata.original_candidate_id);
  if (!arenaRunId || !originalRouteId || !originalCandidateId) throw new Error(`${state.decision.route_id}: malformed Replay Arena attribution metadata`);
  if (state.decision.selection.candidate_id !== originalCandidateId) throw new Error(`${state.decision.route_id}: selected candidate disagrees with Replay Arena attribution`);
  const candidate = state.decision.candidates.find((item) => item.id === originalCandidateId);
  if (!candidate) throw new Error(`${state.decision.route_id}: attributed candidate is absent from receipt`);
  if (!state.latest_observation) {
    warnings.push(`${state.decision.route_id}: replay candidate has no observation`);
    return undefined;
  }
  return {
    unit_id: `${arenaRunId}\u0000${originalRouteId}`,
    arena_run_id: arenaRunId,
    original_route_id: originalRouteId,
    task_type: state.decision.task.type,
    candidate_id: originalCandidateId,
    model: candidate.model,
    ...(candidate.provider ? { provider: candidate.provider } : {}),
    outcome: state.latest_observation.outcome,
  };
}

function wilson(wins: number, losses: number): { low: number; high: number } | undefined {
  const n = wins + losses;
  if (!n) return undefined;
  const z = 1.959964;
  const p = wins / n;
  const denominator = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n) / denominator;
  return { low: round(Math.max(0, center - margin)), high: round(Math.min(1, center + margin)) };
}

function candidateStats(samples: ExperimentSample[]): ExperimentCandidateStats[] {
  const groups = new Map<string, ExperimentSample[]>();
  const identity = new Map<string, string>();
  for (const sample of samples) {
    const key = `${sample.provider || ""}\u0000${sample.model}`;
    const previous = identity.get(sample.candidate_id);
    if (previous && previous !== key) throw new Error(`candidate_id ${sample.candidate_id} maps to multiple model/provider identities`);
    identity.set(sample.candidate_id, key);
    const group = groups.get(sample.candidate_id) || [];
    group.push(sample);
    groups.set(sample.candidate_id, group);
  }
  return [...groups.entries()].map(([candidateId, group]) => {
    const outcomes = group.map((sample) => sample.outcome);
    const successes = outcomes.filter((outcome) => outcome.status === "success").length;
    const quality = mean(metric(outcomes, "quality"));
    const latency = mean(metric(outcomes, "latency_ms"));
    const cost = mean(metric(outcomes, "cost_usd"));
    return {
      candidate_id: candidateId,
      model: group[0].model,
      ...(group[0].provider ? { provider: group[0].provider } : {}),
      samples: group.length,
      successes,
      success_rate: round(successes / group.length),
      ...(quality !== undefined ? { mean_quality: round(quality) } : {}),
      ...(latency !== undefined ? { mean_latency_ms: round(latency) } : {}),
      ...(cost !== undefined ? { mean_cost_usd: round(cost) } : {}),
    };
  }).sort((a, b) => b.samples - a.samples || a.candidate_id.localeCompare(b.candidate_id));
}

function comparisonPairs(candidateIds: string[], options: ExperimentAnalysisOptions): Array<[string, string]> {
  if (options.baseline_candidate_id) {
    if (!candidateIds.includes(options.baseline_candidate_id)) throw new Error(`baseline candidate not found: ${options.baseline_candidate_id}`);
    const challengers = options.challenger_candidate_ids?.length ? options.challenger_candidate_ids : candidateIds.filter((id) => id !== options.baseline_candidate_id);
    const missing = challengers.filter((id) => !candidateIds.includes(id));
    if (missing.length) throw new Error(`challenger candidates not found: ${missing.join(", ")}`);
    if (challengers.includes(options.baseline_candidate_id)) throw new Error("baseline candidate cannot also be a challenger");
    return [...new Set(challengers)].sort().map((challenger) => [options.baseline_candidate_id!, challenger]);
  }
  if (options.challenger_candidate_ids?.length) throw new Error("challenger_candidate_ids requires baseline_candidate_id");
  const sorted = [...candidateIds].sort();
  const pairs: Array<[string, string]> = [];
  for (let left = 0; left < sorted.length; left++) for (let right = left + 1; right < sorted.length; right++) pairs.push([sorted[left], sorted[right]]);
  return pairs;
}

function pairwise(samples: ExperimentSample[], pairsToCompare: Array<[string, string]>, tolerance: number): ExperimentPairwiseComparison[] {
  const byUnit = new Map<string, Map<string, ExperimentSample>>();
  for (const sample of samples) {
    const unit = byUnit.get(sample.unit_id) || new Map<string, ExperimentSample>();
    if (unit.has(sample.candidate_id)) throw new Error(`${sample.unit_id}: duplicate measurement for candidate ${sample.candidate_id}`);
    unit.set(sample.candidate_id, sample);
    byUnit.set(sample.unit_id, unit);
  }
  return pairsToCompare.map(([baseline, challenger]) => {
    const pairs = [...byUnit.values()].flatMap((unit) => unit.has(baseline) && unit.has(challenger) ? [[unit.get(baseline)!, unit.get(challenger)!] as const] : []);
    let wins = 0;
    let losses = 0;
    let ties = 0;
    const qualityDeltas: number[] = [];
    const latencyDeltas: number[] = [];
    const costDeltas: number[] = [];
    for (const [base, challenge] of pairs) {
      if (base.outcome.quality !== undefined && challenge.outcome.quality !== undefined) {
        const delta = challenge.outcome.quality - base.outcome.quality;
        qualityDeltas.push(delta);
        if (delta > tolerance) wins++;
        else if (delta < -tolerance) losses++;
        else ties++;
      }
      if (base.outcome.latency_ms !== undefined && challenge.outcome.latency_ms !== undefined) latencyDeltas.push(challenge.outcome.latency_ms - base.outcome.latency_ms);
      if (base.outcome.cost_usd !== undefined && challenge.outcome.cost_usd !== undefined) costDeltas.push(challenge.outcome.cost_usd - base.outcome.cost_usd);
    }
    const interval = wilson(wins, losses);
    const qualityMean = mean(qualityDeltas);
    const latencyMean = mean(latencyDeltas);
    const costMean = mean(costDeltas);
    return {
      baseline_candidate_id: baseline,
      challenger_candidate_id: challenger,
      matched_pairs: pairs.length,
      quality_pairs: qualityDeltas.length,
      challenger_quality_wins: wins,
      challenger_quality_losses: losses,
      quality_ties: ties,
      ...(wins + losses ? { challenger_quality_win_rate: round(wins / (wins + losses)) } : {}),
      ...(interval ? { challenger_quality_win_rate_95ci: interval } : {}),
      ...(qualityMean !== undefined ? { mean_quality_delta: round(qualityMean) } : {}),
      ...(latencyMean !== undefined ? { mean_latency_delta_ms: round(latencyMean) } : {}),
      ...(costMean !== undefined ? { mean_cost_delta_usd: round(costMean) } : {}),
    };
  });
}

function slice(samples: ExperimentSample[], pairsToCompare: Array<[string, string]>, tolerance: number): ExperimentSliceReport {
  return {
    samples: samples.length,
    paired_units: new Set(samples.map((sample) => sample.unit_id)).size,
    candidates: candidateStats(samples),
    comparisons: pairwise(samples, pairsToCompare, tolerance),
  };
}

function comparisonWarnings(comparisons: ExperimentPairwiseComparison[], warnings: string[], prefix = ""): void {
  for (const comparison of comparisons) {
    const label = `${prefix}${comparison.baseline_candidate_id}/${comparison.challenger_candidate_id}`;
    if (!comparison.matched_pairs) warnings.push(`${label}: no paired tasks`);
    else if (!comparison.quality_pairs) warnings.push(`${label}: paired tasks have no quality measurements`);
  }
}

export function analyzeReplayExperiment(records: RouteRecord[], options: ExperimentAnalysisOptions = {}): ReplayExperimentReport {
  const tolerance = options.quality_tie_tolerance ?? 0;
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 1) throw new Error("quality_tie_tolerance must be 0..1");
  if (options.generated_at !== undefined && Number.isNaN(Date.parse(options.generated_at))) throw new Error("generated_at must be an RFC3339 timestamp");
  const warnings: string[] = [];
  const samples = [...foldRouteRecords(records).values()].flatMap((state) => {
    const sample = replaySample(state, warnings);
    return sample ? [sample] : [];
  });
  if (!samples.length) throw new Error("experiment analysis found no observed Replay Arena receipts");
  const pairsToCompare = comparisonPairs([...new Set(samples.map((sample) => sample.candidate_id))], options);
  const report = slice(samples, pairsToCompare, tolerance);
  comparisonWarnings(report.comparisons, warnings);
  const byTaskType = Object.fromEntries([...new Set(samples.map((sample) => sample.task_type))].sort().map((taskType) => [taskType, slice(samples.filter((sample) => sample.task_type === taskType), pairsToCompare, tolerance)]));
  for (const [taskType, taskReport] of Object.entries(byTaskType)) comparisonWarnings(taskReport.comparisons, warnings, `task_type:${taskType}: `);
  return {
    experiment_version: "0.1",
    generated_at: options.generated_at || new Date().toISOString(),
    arena_runs: new Set(samples.map((sample) => sample.arena_run_id)).size,
    ...report,
    by_task_type: byTaskType,
    warnings,
  };
}
