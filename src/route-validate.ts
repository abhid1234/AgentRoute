// Zero-dependency AgentRoute runtime validation.
import type { RouteDecision, RouteObservation, RouteRecord } from "./route-types.js";

export interface RouteValidationResult {
  valid: boolean;
  errors: string[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isNonNegative = (value: unknown): boolean => isFiniteNumber(value) && value >= 0;
const isUnit = (value: unknown): boolean => isFiniteNumber(value) && value >= 0 && value <= 1;
const isTimestamp = (value: unknown): boolean =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value));
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
const unique = (values: string[]): boolean => new Set(values).size === values.length;
const optionalString = (object: Record<string, unknown>, key: string, path: string, errors: string[]): void => {
  if (object[key] !== undefined && typeof object[key] !== "string") errors.push(`${path}.${key} must be a string`);
};

function validateDecision(doc: Record<string, unknown>, errors: string[]): void {
  if (typeof doc.route_id !== "string" || !doc.route_id) errors.push("missing/invalid `route_id`");
  if (!isTimestamp(doc.created_at)) errors.push("missing/invalid `created_at` (RFC3339 timestamp)");

  if (!isObject(doc.task) || typeof doc.task.type !== "string" || !doc.task.type) {
    errors.push("missing/invalid `task.type`");
  } else { optionalString(doc.task, "description", "task", errors); optionalString(doc.task, "fingerprint", "task", errors); }
  if (!isObject(doc.router) || typeof doc.router.name !== "string" || !doc.router.name) {
    errors.push("missing/invalid `router.name`");
  } else for (const key of ["version", "policy_id", "policy_version"]) optionalString(doc.router, key, "router", errors);
  if (!isObject(doc.source)) {
    errors.push("missing/invalid `source`");
  } else {
    if (typeof doc.source.kind !== "string" || !doc.source.kind) errors.push("missing/invalid `source.kind`");
    if (!["full", "partial", "selected-only"].includes(String(doc.source.fidelity))) errors.push("`source.fidelity` must be full|partial|selected-only");
    optionalString(doc.source, "event_id", "source", errors);
  }

  const candidateIds = new Set<string>();
  if (!Array.isArray(doc.candidates) || doc.candidates.length === 0) {
    errors.push("`candidates` must contain at least one candidate");
  } else {
    doc.candidates.forEach((candidate, index) => {
      if (!isObject(candidate)) {
        errors.push(`candidates[${index}] is not an object`);
        return;
      }
      if (typeof candidate.id !== "string" || !candidate.id) errors.push(`candidates[${index}].id must be non-empty`);
      else if (candidateIds.has(candidate.id)) errors.push(`duplicate candidate id: ${candidate.id}`);
      else candidateIds.add(candidate.id);
      if (typeof candidate.model !== "string" || !candidate.model) errors.push(`candidates[${index}].model must be non-empty`);
      for (const key of ["provider", "endpoint"]) optionalString(candidate, key, `candidates[${index}]`, errors);
      if (candidate.eligible !== undefined && typeof candidate.eligible !== "boolean") errors.push(`candidates[${index}].eligible must be boolean`);
      if (candidate.capabilities !== undefined && (!isStringArray(candidate.capabilities) || !unique(candidate.capabilities))) errors.push(`candidates[${index}].capabilities must contain unique non-empty strings`);
      if (candidate.ineligible_reasons !== undefined && !isStringArray(candidate.ineligible_reasons)) errors.push(`candidates[${index}].ineligible_reasons must contain non-empty strings`);
      if (candidate.estimates !== undefined) {
        if (!isObject(candidate.estimates)) errors.push(`candidates[${index}].estimates must be an object`);
        else {
          for (const key of ["latency_ms", "cost_usd"] as const) {
            const value = candidate.estimates[key];
            if (value !== undefined && !isNonNegative(value)) errors.push(`candidates[${index}].estimates.${key} must be >= 0`);
          }
          if (candidate.estimates.quality !== undefined && !isUnit(candidate.estimates.quality)) errors.push(`candidates[${index}].estimates.quality must be 0..1`);
        }
      }
      if (candidate.scores !== undefined) {
        if (!isObject(candidate.scores)) errors.push(`candidates[${index}].scores must be an object`);
        else for (const key of ["overall", "quality", "latency", "cost", "capability"] as const) {
          const value = candidate.scores[key];
          if (value !== undefined && !isUnit(value)) errors.push(`candidates[${index}].scores.${key} must be 0..1`);
        }
        if (isObject(candidate.scores) && candidate.scores.custom !== undefined && (!isObject(candidate.scores.custom) || Object.values(candidate.scores.custom).some((value) => !isFiniteNumber(value)))) errors.push(`candidates[${index}].scores.custom must contain finite numbers`);
      }
    });
  }

  if (!isObject(doc.selection)) {
    errors.push("missing/invalid `selection`");
  } else {
    if (typeof doc.selection.candidate_id !== "string" || !doc.selection.candidate_id) errors.push("missing/invalid `selection.candidate_id`");
    else if (!candidateIds.has(doc.selection.candidate_id)) errors.push("`selection.candidate_id` does not reference a candidate");
    if (typeof doc.selection.reason !== "string" || !doc.selection.reason.trim()) errors.push("missing/invalid `selection.reason`");
    if (doc.selection.confidence !== undefined && !isUnit(doc.selection.confidence)) errors.push("`selection.confidence` must be 0..1");
    if (doc.selection.fallback_order !== undefined && !Array.isArray(doc.selection.fallback_order)) errors.push("`selection.fallback_order` must be an array");
    if (Array.isArray(doc.selection.fallback_order)) {
      for (const id of doc.selection.fallback_order) if (typeof id !== "string" || !candidateIds.has(id)) errors.push(`fallback candidate does not exist: ${String(id)}`);
      if (isStringArray(doc.selection.fallback_order) && !unique(doc.selection.fallback_order)) errors.push("`selection.fallback_order` must contain unique candidate IDs");
    }
    for (const key of ["constraints_satisfied", "tradeoffs"]) if (doc.selection[key] !== undefined && !isStringArray(doc.selection[key])) errors.push(`selection.${key} must contain non-empty strings`);
  }

  if (doc.criteria !== undefined) {
    if (!isObject(doc.criteria)) errors.push("`criteria` must be an object");
    else {
      for (const key of ["max_cost_usd", "max_latency_ms"] as const) {
        const value = doc.criteria[key];
        if (value !== undefined && !isNonNegative(value)) errors.push(`criteria.${key} must be >= 0`);
      }
      if (doc.criteria.min_quality !== undefined && !isUnit(doc.criteria.min_quality)) errors.push("criteria.min_quality must be 0..1");
      if (doc.criteria.required_capabilities !== undefined && (!isStringArray(doc.criteria.required_capabilities) || !unique(doc.criteria.required_capabilities))) errors.push("criteria.required_capabilities must contain unique non-empty strings");
      if (doc.criteria.weights !== undefined && !isObject(doc.criteria.weights)) errors.push("criteria.weights must be an object");
      if (isObject(doc.criteria.weights)) {
        for (const [key, value] of Object.entries(doc.criteria.weights)) if (!isUnit(value)) errors.push(`criteria.weights.${key} must be 0..1`);
        const values = Object.values(doc.criteria.weights).filter(isFiniteNumber);
        if (values.length && Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > 1e-9) errors.push("criteria.weights must sum to 1");
      }
      if (doc.criteria.custom !== undefined && !isObject(doc.criteria.custom)) errors.push("criteria.custom must be an object");
    }
  }
  if (doc.context !== undefined) {
    if (!isObject(doc.context)) errors.push("`context` must be an object");
    else for (const key of ["trajectory_id", "ot_step_ref", "session_id", "parent_route_id", "traceparent"]) optionalString(doc.context, key, "context", errors);
  }
  if (doc.extensions !== undefined && !isObject(doc.extensions)) errors.push("`extensions` must be an object");
}

function validateObservation(doc: Record<string, unknown>, errors: string[]): void {
  if (typeof doc.route_id !== "string" || !doc.route_id) errors.push("missing/invalid `route_id`");
  if (typeof doc.observation_id !== "string" || !doc.observation_id) errors.push("missing/invalid `observation_id`");
  if (!isTimestamp(doc.observed_at)) errors.push("missing/invalid `observed_at` (RFC3339 timestamp)");
  if (!isObject(doc.outcome)) errors.push("missing/invalid `outcome`");
  else {
    const statuses = ["success", "failure", "partial", "cancelled", "unknown"];
    if (!statuses.includes(String(doc.outcome.status))) errors.push(`outcome.status must be one of ${statuses.join("|")}`);
    for (const key of ["latency_ms", "cost_usd"] as const) {
      const value = doc.outcome[key];
      if (value !== undefined && !isNonNegative(value)) errors.push(`outcome.${key} must be >= 0`);
    }
    if (doc.outcome.quality !== undefined && !isUnit(doc.outcome.quality)) errors.push("outcome.quality must be 0..1");
    for (const key of ["actual_model", "actual_provider", "trajectory_ref", "error"]) optionalString(doc.outcome, key, "outcome", errors);
    if (doc.outcome.metadata !== undefined && !isObject(doc.outcome.metadata)) errors.push("outcome.metadata must be an object");
  }
  if (doc.extensions !== undefined && !isObject(doc.extensions)) errors.push("`extensions` must be an object");
}

export function validateRouteRecord(doc: unknown): RouteValidationResult {
  const errors: string[] = [];
  if (!isObject(doc)) return { valid: false, errors: ["record is not a JSON object"] };
  if (doc.route_version !== "0.1") errors.push("`route_version` must equal 0.1");
  if (doc.record_type === "decision") validateDecision(doc, errors);
  else if (doc.record_type === "observation") validateObservation(doc, errors);
  else errors.push("`record_type` must be decision|observation");
  return { valid: errors.length === 0, errors };
}

export function validateRouteLedger(records: unknown[]): RouteValidationResult {
  const errors: string[] = [];
  const decisions = new Map<string, RouteDecision>();
  const observations = new Map<string, string>();
  const lastObservedAt = new Map<string, number>();

  records.forEach((record, index) => {
    const result = validateRouteRecord(record);
    for (const error of result.errors) errors.push(`record[${index}]: ${error}`);
    if (!result.valid || !isObject(record)) return;
    if (record.record_type === "decision") {
      const decision = record as unknown as RouteDecision;
      if (decisions.has(decision.route_id)) errors.push(`record[${index}]: duplicate decision for route_id ${decision.route_id}`);
      else decisions.set(decision.route_id, decision);
      return;
    }
    const observation = record as unknown as RouteObservation;
    if (!decisions.has(observation.route_id)) errors.push(`record[${index}]: observation precedes decision for route_id ${observation.route_id}`);
    else if (Date.parse(observation.observed_at) < Date.parse(decisions.get(observation.route_id)!.created_at)) errors.push(`record[${index}]: observed_at predates decision for route_id ${observation.route_id}`);
    const existingRoute = observations.get(observation.observation_id);
    if (existingRoute) errors.push(`record[${index}]: duplicate observation_id ${observation.observation_id}`);
    else observations.set(observation.observation_id, observation.route_id);
    const stamp = Date.parse(observation.observed_at);
    const previous = lastObservedAt.get(observation.route_id);
    if (previous !== undefined && stamp < previous) errors.push(`record[${index}]: observed_at is not monotonic for route_id ${observation.route_id}`);
    lastObservedAt.set(observation.route_id, stamp);
  });

  return { valid: errors.length === 0, errors };
}

export function assertRouteRecord(doc: unknown): RouteRecord {
  const result = validateRouteRecord(doc);
  if (!result.valid) throw new Error("AgentRoute validation failed:\n  - " + result.errors.join("\n  - "));
  return doc as RouteRecord;
}
