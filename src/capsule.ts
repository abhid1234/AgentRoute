import { readFileSync, writeFileSync } from "node:fs";
import { auditRouteRecords } from "./route-audit.js";
import { canonicalJson, sha256 } from "./canonical.js";
import { renderDecisionLab } from "./decision-lab.js";
import type { AgentRoutePolicy } from "./policy-registry.js";
import { validatePolicy } from "./policy-registry.js";
import type { RouteDecision, RouteObservation, RouteRecord } from "./route-types.js";
import { replayRoutes } from "./route.js";
import { validateRouteLedger } from "./route-validate.js";

export interface EvidenceCapsule {
  capsule_version: "0.1";
  created_at: string;
  manifest: {
    format: "agentroute-evidence-capsule";
    record_count: number;
    policy_count: number;
    payload_sha256: string;
    root_sha256: string;
  };
  payload: {
    records: RouteRecord[];
    policies: AgentRoutePolicy[];
    replay: ReturnType<typeof replayRoutes>;
    audit: ReturnType<typeof auditRouteRecords>;
  };
}

export interface CapsuleVerification {
  valid: boolean;
  errors: string[];
  record_count: number;
  policy_count: number;
  root_sha256?: string;
}

function sanitizeDecision(decision: RouteDecision): RouteDecision {
  return {
    route_version: decision.route_version,
    record_type: "decision",
    route_id: decision.route_id,
    created_at: decision.created_at,
    task: { type: decision.task.type, ...(decision.task.fingerprint ? { fingerprint: decision.task.fingerprint } : {}) },
    router: { ...decision.router },
    source: { kind: decision.source.kind, fidelity: decision.source.fidelity },
    candidates: decision.candidates.map((candidate) => ({
      id: candidate.id,
      model: candidate.model,
      ...(candidate.provider ? { provider: candidate.provider } : {}),
      ...(candidate.capabilities ? { capabilities: [...candidate.capabilities] } : {}),
      ...(candidate.eligible !== undefined ? { eligible: candidate.eligible } : {}),
      ...(candidate.estimates ? { estimates: { ...candidate.estimates } } : {}),
      ...(candidate.scores ? { scores: { ...candidate.scores, ...(candidate.scores.custom ? { custom: undefined } : {}) } } : {}),
    })),
    ...(decision.criteria ? { criteria: { ...decision.criteria, custom: undefined } } : {}),
    selection: {
      candidate_id: decision.selection.candidate_id,
      reason: "selection reason omitted from portable capsule",
      ...(decision.selection.confidence !== undefined ? { confidence: decision.selection.confidence } : {}),
      ...(decision.selection.fallback_order ? { fallback_order: [...decision.selection.fallback_order] } : {}),
    },
    ...(decision.context?.parent_route_id ? { context: { parent_route_id: decision.context.parent_route_id } } : {}),
  };
}

function sanitizeObservation(observation: RouteObservation): RouteObservation {
  const outcome = observation.outcome;
  return {
    route_version: observation.route_version,
    record_type: "observation",
    route_id: observation.route_id,
    observation_id: observation.observation_id,
    observed_at: observation.observed_at,
    outcome: {
      status: outcome.status,
      ...(outcome.actual_model ? { actual_model: outcome.actual_model } : {}),
      ...(outcome.actual_provider ? { actual_provider: outcome.actual_provider } : {}),
      ...(outcome.latency_ms !== undefined ? { latency_ms: outcome.latency_ms } : {}),
      ...(outcome.cost_usd !== undefined ? { cost_usd: outcome.cost_usd } : {}),
      ...(outcome.quality !== undefined ? { quality: outcome.quality } : {}),
    },
  };
}

export function sanitizeCapsuleRecords(records: RouteRecord[]): RouteRecord[] {
  const sanitized = records.map((record) => record.record_type === "decision" ? sanitizeDecision(record) : sanitizeObservation(record));
  const result = validateRouteLedger(sanitized);
  if (!result.valid) throw new Error(`sanitized capsule ledger is invalid:\n  - ${result.errors.join("\n  - ")}`);
  return sanitized;
}

function rootHash(createdAt: string, payloadHash: string, recordCount: number, policyCount: number): string {
  return sha256({ capsule_version: "0.1", created_at: createdAt, payload_sha256: payloadHash, record_count: recordCount, policy_count: policyCount });
}

export function createEvidenceCapsule(records: RouteRecord[], policyValues: unknown[] = [], createdAt = new Date().toISOString()): EvidenceCapsule {
  if (Number.isNaN(Date.parse(createdAt))) throw new Error("capsule created_at must be an RFC3339 timestamp");
  const safeRecords = sanitizeCapsuleRecords(records);
  const policies = policyValues.map((value) => {
    const policy = validatePolicy(value);
    return {
      policy_version: policy.policy_version,
      id: policy.id,
      version: policy.version,
      status: policy.status,
      weights: { ...policy.weights },
      ...(policy.criteria ? { criteria: { ...policy.criteria, custom: undefined } } : {}),
      ...(policy.models ? { models: policy.models.map((model) => ({ ...model })) } : {}),
    } as AgentRoutePolicy;
  });
  const payload: EvidenceCapsule["payload"] = {
    records: safeRecords,
    policies,
    replay: replayRoutes(safeRecords, createdAt),
    audit: auditRouteRecords(safeRecords, createdAt),
  };
  const payloadHash = sha256(payload);
  return {
    capsule_version: "0.1",
    created_at: createdAt,
    manifest: {
      format: "agentroute-evidence-capsule",
      record_count: safeRecords.length,
      policy_count: policies.length,
      payload_sha256: payloadHash,
      root_sha256: rootHash(createdAt, payloadHash, safeRecords.length, policies.length),
    },
    payload,
  };
}

export function verifyEvidenceCapsule(value: unknown): CapsuleVerification {
  const errors: string[] = [];
  const capsule = value as Partial<EvidenceCapsule>;
  if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false, errors: ["capsule must be an object"], record_count: 0, policy_count: 0 };
  if (capsule.capsule_version !== "0.1") errors.push("capsule_version must equal 0.1");
  if (!capsule.created_at || Number.isNaN(Date.parse(capsule.created_at))) errors.push("created_at must be an RFC3339 timestamp");
  if (!capsule.manifest || capsule.manifest.format !== "agentroute-evidence-capsule") errors.push("manifest format is invalid");
  const records = Array.isArray(capsule.payload?.records) ? capsule.payload!.records : [];
  const policies = Array.isArray(capsule.payload?.policies) ? capsule.payload!.policies : [];
  const ledger = validateRouteLedger(records);
  errors.push(...ledger.errors.map((error) => `payload.records: ${error}`));
  policies.forEach((policy, index) => { try { validatePolicy(policy); } catch (error) { errors.push(`payload.policies[${index}]: ${(error as Error).message}`); } });
  if (capsule.payload && capsule.created_at && !Number.isNaN(Date.parse(capsule.created_at)) && ledger.valid) {
    if (canonicalJson(capsule.payload.replay) !== canonicalJson(replayRoutes(records, capsule.created_at))) errors.push("payload replay summary does not match records");
    if (canonicalJson(capsule.payload.audit) !== canonicalJson(auditRouteRecords(records, capsule.created_at))) errors.push("payload audit summary does not match records");
  }
  if (capsule.manifest) {
    if (capsule.manifest.record_count !== records.length) errors.push("manifest record_count does not match payload");
    if (capsule.manifest.policy_count !== policies.length) errors.push("manifest policy_count does not match payload");
    if (capsule.payload) {
      const payloadHash = sha256(capsule.payload);
      if (capsule.manifest.payload_sha256 !== payloadHash) errors.push("payload SHA-256 mismatch");
      if (capsule.created_at) {
        const expectedRoot = rootHash(capsule.created_at, payloadHash, records.length, policies.length);
        if (capsule.manifest.root_sha256 !== expectedRoot) errors.push("root SHA-256 mismatch");
      }
    }
  }
  return { valid: errors.length === 0, errors, record_count: records.length, policy_count: policies.length, ...(capsule.manifest?.root_sha256 ? { root_sha256: capsule.manifest.root_sha256 } : {}) };
}

export function writeEvidenceCapsule(path: string, capsule: EvidenceCapsule): void {
  writeFileSync(path, canonicalCapsule(capsule) + "\n");
}

export function loadEvidenceCapsule(path: string): EvidenceCapsule {
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const result = verifyEvidenceCapsule(value);
  if (!result.valid) throw new Error(`invalid AgentRoute capsule:\n  - ${result.errors.join("\n  - ")}`);
  return value as EvidenceCapsule;
}

export function renderCapsuleLab(capsule: EvidenceCapsule): string {
  const result = verifyEvidenceCapsule(capsule);
  if (!result.valid) throw new Error(`cannot render invalid AgentRoute capsule:\n  - ${result.errors.join("\n  - ")}`);
  return renderDecisionLab(capsule.payload.records, capsule.created_at);
}

export function canonicalCapsule(capsule: EvidenceCapsule): string {
  return canonicalJson(capsule);
}
