import { foldRouteRecords } from "./route.js";
import { ROUTE_VERSION } from "./route-types.js";
import type { RouteCandidate, RouteCriteria, RouteRecord } from "./route-types.js";

export interface ScenarioModelSelector {
  model: string;
  provider?: string;
}

export interface ScenarioMultiplier extends ScenarioModelSelector {
  multiplier: number;
}

export interface RoutingScenario {
  scenario_version: "0.1";
  id: string;
  unavailable_providers?: string[];
  unavailable_models?: ScenarioModelSelector[];
  cost_multipliers?: ScenarioMultiplier[];
  latency_multipliers?: ScenarioMultiplier[];
  criteria?: RouteCriteria;
}

export interface ScenarioChoice {
  route_id: string;
  task_type: string;
  original_candidate_id: string;
  scenario_candidate_id?: string;
  original_identity: string;
  scenario_identity?: string;
  changed: boolean;
  stranded: boolean;
  reasons: string[];
  original_cost_usd?: number;
  projected_cost_usd?: number;
  cost_delta_usd?: number;
  original_latency_ms?: number;
  projected_latency_ms?: number;
  latency_delta_ms?: number;
}

export interface RoutingScenarioReport {
  route_version: string;
  scenario_report_version: "0.1";
  generated_at: string;
  scenario: RoutingScenario;
  result: "no-impact" | "impact" | "insufficient";
  decisions: number;
  analyzed: number;
  impacted: number;
  changed: number;
  stranded: number;
  skipped_incomplete_evidence: number;
  cost_comparable_routes: number;
  original_cost_usd?: number;
  projected_cost_usd?: number;
  cost_delta_usd?: number;
  latency_comparable_routes: number;
  original_mean_latency_ms?: number;
  projected_mean_latency_ms?: number;
  latency_delta_ms?: number;
  choices: ScenarioChoice[];
  warnings: string[];
}

const SCENARIO_KEYS = new Set(["scenario_version", "id", "unavailable_providers", "unavailable_models", "cost_multipliers", "latency_multipliers", "criteria"]);
const SELECTOR_KEYS = new Set(["model", "provider"]);
const MULTIPLIER_KEYS = new Set(["model", "provider", "multiplier"]);
const CRITERIA_KEYS = new Set(["max_cost_usd", "max_latency_ms", "min_quality", "required_capabilities"]);
const rounded = (value: number, digits = 6): number => Number(value.toFixed(digits));

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function rejectUnknown(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`${label} contains unknown keys: ${unknown.sort().join(", ")}`);
}

function validateStrings(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) throw new Error(`${label} must contain non-empty strings`);
  if (new Set(value).size !== value.length) throw new Error(`${label} must not contain duplicates`);
  return [...value].sort();
}

function validateSelector(value: unknown, label: string, multiplier: boolean): ScenarioModelSelector | ScenarioMultiplier {
  assertObject(value, label);
  rejectUnknown(value, multiplier ? MULTIPLIER_KEYS : SELECTOR_KEYS, label);
  if (typeof value.model !== "string" || !value.model) throw new Error(`${label}.model must be a non-empty string`);
  if (value.provider !== undefined && (typeof value.provider !== "string" || !value.provider)) throw new Error(`${label}.provider must be a non-empty string`);
  if (multiplier && (typeof value.multiplier !== "number" || !Number.isFinite(value.multiplier) || value.multiplier <= 0)) throw new Error(`${label}.multiplier must be a finite number > 0`);
  return {
    model: value.model,
    ...(value.provider ? { provider: value.provider as string } : {}),
    ...(multiplier ? { multiplier: value.multiplier as number } : {}),
  } as ScenarioMultiplier;
}

function validateSelectorList(value: unknown, label: string, multiplier: boolean): (ScenarioModelSelector | ScenarioMultiplier)[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const selectors = value.map((item, index) => validateSelector(item, `${label}[${index}]`, multiplier));
  const keys = selectors.map((item) => `${item.provider || "*"}\u0000${item.model}`);
  if (new Set(keys).size !== keys.length) throw new Error(`${label} must not contain duplicate selectors`);
  return selectors.sort((a, b) => `${a.provider || ""}/${a.model}`.localeCompare(`${b.provider || ""}/${b.model}`));
}

function validateCriteria(value: unknown): RouteCriteria | undefined {
  if (value === undefined) return undefined;
  assertObject(value, "scenario.criteria");
  rejectUnknown(value, CRITERIA_KEYS, "scenario.criteria");
  const criteria = value as RouteCriteria;
  for (const key of ["max_cost_usd", "max_latency_ms"] as const) {
    const item = criteria[key];
    if (item !== undefined && (!Number.isFinite(item) || item < 0)) throw new Error(`scenario.criteria.${key} must be a finite number >= 0`);
  }
  if (criteria.min_quality !== undefined && (!Number.isFinite(criteria.min_quality) || criteria.min_quality < 0 || criteria.min_quality > 1)) throw new Error("scenario.criteria.min_quality must be in the range 0..1");
  const capabilities = validateStrings(criteria.required_capabilities, "scenario.criteria.required_capabilities");
  return {
    ...(criteria.max_cost_usd !== undefined ? { max_cost_usd: criteria.max_cost_usd } : {}),
    ...(criteria.max_latency_ms !== undefined ? { max_latency_ms: criteria.max_latency_ms } : {}),
    ...(criteria.min_quality !== undefined ? { min_quality: criteria.min_quality } : {}),
    ...(criteria.required_capabilities !== undefined ? { required_capabilities: capabilities } : {}),
  };
}

export function validateRoutingScenario(value: unknown): RoutingScenario {
  assertObject(value, "scenario");
  rejectUnknown(value, SCENARIO_KEYS, "scenario");
  if (value.scenario_version !== "0.1") throw new Error("scenario.scenario_version must be 0.1");
  if (typeof value.id !== "string" || !value.id) throw new Error("scenario.id must be a non-empty string");
  return {
    scenario_version: "0.1",
    id: value.id,
    ...(value.unavailable_providers !== undefined ? { unavailable_providers: validateStrings(value.unavailable_providers, "scenario.unavailable_providers") } : {}),
    ...(value.unavailable_models !== undefined ? { unavailable_models: validateSelectorList(value.unavailable_models, "scenario.unavailable_models", false) as ScenarioModelSelector[] } : {}),
    ...(value.cost_multipliers !== undefined ? { cost_multipliers: validateSelectorList(value.cost_multipliers, "scenario.cost_multipliers", true) as ScenarioMultiplier[] } : {}),
    ...(value.latency_multipliers !== undefined ? { latency_multipliers: validateSelectorList(value.latency_multipliers, "scenario.latency_multipliers", true) as ScenarioMultiplier[] } : {}),
    ...(value.criteria !== undefined ? { criteria: validateCriteria(value.criteria) } : {}),
  };
}

function identity(candidate: RouteCandidate): string {
  return candidate.provider ? `${candidate.provider}/${candidate.model}` : candidate.model;
}

function matches(candidate: RouteCandidate, selector: ScenarioModelSelector): boolean {
  return candidate.model === selector.model && (selector.provider === undefined || candidate.provider === selector.provider);
}

function multiplier(candidate: RouteCandidate, rules: ScenarioMultiplier[] | undefined): number {
  return (rules || []).filter((rule) => matches(candidate, rule)).reduce((result, rule) => result * rule.multiplier, 1);
}

function combineCriteria(recorded: RouteCriteria | undefined, scenario: RouteCriteria | undefined): RouteCriteria | undefined {
  if (!recorded && !scenario) return undefined;
  const maxima = (key: "max_cost_usd" | "max_latency_ms"): number | undefined => {
    const values = [recorded?.[key], scenario?.[key]].filter((item): item is number => item !== undefined);
    return values.length ? Math.min(...values) : undefined;
  };
  const quality = [recorded?.min_quality, scenario?.min_quality].filter((item): item is number => item !== undefined);
  const capabilities = [...new Set([...(recorded?.required_capabilities || []), ...(scenario?.required_capabilities || [])])].sort();
  return {
    ...(maxima("max_cost_usd") !== undefined ? { max_cost_usd: maxima("max_cost_usd") } : {}),
    ...(maxima("max_latency_ms") !== undefined ? { max_latency_ms: maxima("max_latency_ms") } : {}),
    ...(quality.length ? { min_quality: Math.max(...quality) } : {}),
    ...(capabilities.length ? { required_capabilities: capabilities } : {}),
  };
}

function projected(candidate: RouteCandidate, scenario: RoutingScenario): { cost_usd?: number; latency_ms?: number } {
  return {
    ...(candidate.estimates?.cost_usd !== undefined ? { cost_usd: rounded(candidate.estimates.cost_usd * multiplier(candidate, scenario.cost_multipliers)) } : {}),
    ...(candidate.estimates?.latency_ms !== undefined ? { latency_ms: rounded(candidate.estimates.latency_ms * multiplier(candidate, scenario.latency_multipliers)) } : {}),
  };
}

function candidateReasons(candidate: RouteCandidate, scenario: RoutingScenario, criteria: RouteCriteria | undefined): string[] {
  const reasons: string[] = [];
  if (candidate.eligible === false) reasons.push("recorded-ineligible");
  if (candidate.provider && scenario.unavailable_providers?.includes(candidate.provider)) reasons.push("provider-unavailable");
  if (scenario.unavailable_models?.some((selector) => matches(candidate, selector))) reasons.push("model-unavailable");
  const estimates = projected(candidate, scenario);
  if (criteria?.max_cost_usd !== undefined && (estimates.cost_usd === undefined || estimates.cost_usd > criteria.max_cost_usd)) reasons.push(estimates.cost_usd === undefined ? "cost-estimate-missing" : "cost-ceiling-exceeded");
  if (criteria?.max_latency_ms !== undefined && (estimates.latency_ms === undefined || estimates.latency_ms > criteria.max_latency_ms)) reasons.push(estimates.latency_ms === undefined ? "latency-estimate-missing" : "latency-ceiling-exceeded");
  if (criteria?.min_quality !== undefined && (candidate.estimates?.quality === undefined || candidate.estimates.quality < criteria.min_quality)) reasons.push(candidate.estimates?.quality === undefined ? "quality-estimate-missing" : "quality-floor-missed");
  if (criteria?.required_capabilities?.some((capability) => !(candidate.capabilities || []).includes(capability))) reasons.push("required-capability-missing");
  return reasons;
}

export function runRoutingScenario(records: RouteRecord[], input: unknown, generatedAt = new Date().toISOString()): RoutingScenarioReport {
  if (Number.isNaN(Date.parse(generatedAt))) throw new Error("scenario generated_at must be an ISO-8601 timestamp");
  const scenario = validateRoutingScenario(input);
  const states = [...foldRouteRecords(records).values()];
  const choices: ScenarioChoice[] = [];
  const warnings: string[] = [];
  let skippedIncomplete = 0;
  for (const state of states) {
    const decision = state.decision;
    if (decision.source.fidelity !== "full") {
      skippedIncomplete++;
      warnings.push(`${decision.route_id}: skipped ${decision.source.fidelity} candidate evidence`);
      continue;
    }
    const original = decision.candidates.find((candidate) => candidate.id === decision.selection.candidate_id)!;
    const declared = [decision.selection.candidate_id, ...(decision.selection.fallback_order || [])];
    const remaining = decision.candidates.map((candidate) => candidate.id).filter((id) => !declared.includes(id)).sort();
    const orderedIds = [...new Set([...declared, ...remaining])];
    const criteria = combineCriteria(decision.criteria, scenario.criteria);
    const evaluations = orderedIds.map((id) => {
      const candidate = decision.candidates.find((item) => item.id === id)!;
      return { candidate, reasons: candidateReasons(candidate, scenario, criteria) };
    });
    const selected = evaluations.find((entry) => entry.reasons.length === 0)?.candidate;
    const originalProjected = projected(original, scenario);
    const selectedProjected = selected ? projected(selected, scenario) : undefined;
    const reasons = selected ? candidateReasons(original, scenario, criteria) : [...new Set(evaluations.flatMap((entry) => entry.reasons))].sort();
    const choice: ScenarioChoice = {
      route_id: decision.route_id,
      task_type: decision.task.type,
      original_candidate_id: original.id,
      ...(selected ? { scenario_candidate_id: selected.id } : {}),
      original_identity: identity(original),
      ...(selected ? { scenario_identity: identity(selected) } : {}),
      changed: Boolean(selected && selected.id !== original.id),
      stranded: !selected,
      reasons,
      ...(original.estimates?.cost_usd !== undefined ? { original_cost_usd: original.estimates.cost_usd } : {}),
      ...(selectedProjected?.cost_usd !== undefined ? { projected_cost_usd: selectedProjected.cost_usd } : {}),
      ...(original.estimates?.cost_usd !== undefined && selectedProjected?.cost_usd !== undefined ? { cost_delta_usd: rounded(selectedProjected.cost_usd - original.estimates.cost_usd) } : {}),
      ...(original.estimates?.latency_ms !== undefined ? { original_latency_ms: original.estimates.latency_ms } : {}),
      ...(selectedProjected?.latency_ms !== undefined ? { projected_latency_ms: selectedProjected.latency_ms } : {}),
      ...(original.estimates?.latency_ms !== undefined && selectedProjected?.latency_ms !== undefined ? { latency_delta_ms: rounded(selectedProjected.latency_ms - original.estimates.latency_ms) } : {}),
    };
    const originalChangedByMultiplier = originalProjected.cost_usd !== original.estimates?.cost_usd || originalProjected.latency_ms !== original.estimates?.latency_ms;
    if (originalChangedByMultiplier && selected?.id === original.id && !choice.reasons.includes("scenario-multiplier-applied")) choice.reasons.push("scenario-multiplier-applied");
    choices.push(choice);
  }
  const comparableCost = choices.filter((choice) => choice.original_cost_usd !== undefined && choice.projected_cost_usd !== undefined);
  const comparableLatency = choices.filter((choice) => choice.original_latency_ms !== undefined && choice.projected_latency_ms !== undefined);
  const originalCost = comparableCost.length ? rounded(comparableCost.reduce((sum, choice) => sum + choice.original_cost_usd!, 0)) : undefined;
  const projectedCost = comparableCost.length ? rounded(comparableCost.reduce((sum, choice) => sum + choice.projected_cost_usd!, 0)) : undefined;
  const originalLatency = comparableLatency.length ? rounded(comparableLatency.reduce((sum, choice) => sum + choice.original_latency_ms!, 0) / comparableLatency.length) : undefined;
  const projectedLatency = comparableLatency.length ? rounded(comparableLatency.reduce((sum, choice) => sum + choice.projected_latency_ms!, 0) / comparableLatency.length) : undefined;
  const impacted = choices.filter((choice) => choice.changed || choice.stranded || choice.cost_delta_usd !== 0 || choice.latency_delta_ms !== 0).length;
  return {
    route_version: ROUTE_VERSION,
    scenario_report_version: "0.1",
    generated_at: generatedAt,
    scenario,
    result: impacted ? "impact" : skippedIncomplete ? "insufficient" : "no-impact",
    decisions: states.length,
    analyzed: choices.length,
    impacted,
    changed: choices.filter((choice) => choice.changed).length,
    stranded: choices.filter((choice) => choice.stranded).length,
    skipped_incomplete_evidence: skippedIncomplete,
    cost_comparable_routes: comparableCost.length,
    ...(originalCost !== undefined ? { original_cost_usd: originalCost } : {}),
    ...(projectedCost !== undefined ? { projected_cost_usd: projectedCost } : {}),
    ...(originalCost !== undefined && projectedCost !== undefined ? { cost_delta_usd: rounded(projectedCost - originalCost) } : {}),
    latency_comparable_routes: comparableLatency.length,
    ...(originalLatency !== undefined ? { original_mean_latency_ms: originalLatency } : {}),
    ...(projectedLatency !== undefined ? { projected_mean_latency_ms: projectedLatency } : {}),
    ...(originalLatency !== undefined && projectedLatency !== undefined ? { latency_delta_ms: rounded(projectedLatency - originalLatency) } : {}),
    choices,
    warnings,
  };
}
