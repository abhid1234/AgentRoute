import { readFileSync, writeFileSync } from "node:fs";
import { canonicalJson, sha256 } from "./canonical.js";
import type { ExperimentDecision, ExperimentProtocol } from "./experiment-protocol.js";
import { validateExperimentDecision, validateExperimentProtocol } from "./experiment-protocol.js";
import type { AgentRoutePolicy, CompiledPolicy, PolicyDiff, PolicyTarget } from "./policy-registry.js";
import { compilePolicy, diffPolicies, validatePolicy } from "./policy-registry.js";
import type { RouteGateResult } from "./quality-gate.js";
import { validateRouteGateResult } from "./quality-gate.js";

export type PromotionVerdict = "eligible" | "blocked" | "insufficient";

export interface PromotionAssessment {
  verdict: PromotionVerdict;
  reasons: string[];
}

export interface PromotionDossier {
  dossier_version: "0.1";
  created_at: string;
  manifest: {
    format: "agentroute-promotion-dossier";
    payload_sha256: string;
    root_sha256: string;
  };
  payload: {
    protocol: ExperimentProtocol;
    decision: ExperimentDecision;
    candidate_policy: AgentRoutePolicy;
    previous_policy?: AgentRoutePolicy;
    policy_diff?: PolicyDiff;
    gate: RouteGateResult;
    compilations: CompiledPolicy[];
    promotion: PromotionAssessment;
  };
}

export interface CreatePromotionDossierOptions {
  protocol: unknown;
  decision: unknown;
  candidate_policy: unknown;
  previous_policy?: unknown;
  gate: unknown;
  targets: PolicyTarget[];
  created_at?: string;
}

export interface PromotionDossierVerification {
  valid: boolean;
  errors: string[];
  verdict?: PromotionVerdict;
  root_sha256?: string;
  protocol_id?: string;
  policy_id?: string;
  targets: string[];
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function safePolicy(value: unknown): AgentRoutePolicy {
  const policy = validatePolicy(value);
  return {
    policy_version: policy.policy_version,
    id: policy.id,
    version: policy.version,
    status: policy.status,
    weights: { ...policy.weights },
    ...(policy.criteria ? { criteria: { ...policy.criteria, custom: undefined } } : {}),
    ...(policy.models ? { models: policy.models.map((model) => ({ ...model })) } : {}),
  };
}

function validateTargets(targets: unknown): PolicyTarget[] {
  const supported: PolicyTarget[] = ["native", "openrouter", "litellm", "portkey", "vercel-ai-gateway"];
  if (!Array.isArray(targets) || !targets.length || targets.some((target) => !supported.includes(target as PolicyTarget))) throw new Error("promotion dossier requires at least one supported compiler target");
  if (new Set(targets).size !== targets.length) throw new Error("promotion dossier compiler targets must be unique");
  return [...(targets as PolicyTarget[])].sort();
}

export function assessPromotion(decision: ExperimentDecision, gate: RouteGateResult, policy: AgentRoutePolicy): PromotionAssessment {
  const blocked: string[] = [];
  const insufficient: string[] = [];
  if (decision.status === "fail") blocked.push("experiment protocol failed");
  else if (decision.status === "insufficient") insufficient.push("experiment protocol has insufficient evidence");
  if (gate.status === "fail") blocked.push("routing quality gate failed");
  else if (gate.status === "neutral") insufficient.push("routing quality gate is neutral");
  if (policy.status !== "reviewed") blocked.push(`candidate policy must be reviewed, not ${policy.status}`);
  if (blocked.length) return { verdict: "blocked", reasons: [...blocked, ...insufficient] };
  if (insufficient.length) return { verdict: "insufficient", reasons: insufficient };
  return { verdict: "eligible", reasons: ["experiment protocol and routing quality gate passed with a reviewed candidate policy"] };
}

function rootHash(createdAt: string, payloadHash: string): string {
  return sha256({ dossier_version: "0.1", created_at: createdAt, payload_sha256: payloadHash });
}

export function createPromotionDossier(options: CreatePromotionDossierOptions): PromotionDossier {
  const createdAt = options.created_at || new Date().toISOString();
  if (Number.isNaN(Date.parse(createdAt))) throw new Error("promotion dossier created_at must be an RFC3339 timestamp");
  const protocol = validateExperimentProtocol(options.protocol);
  const decision = validateExperimentDecision(options.decision, protocol);
  const candidatePolicy = safePolicy(options.candidate_policy);
  const previousPolicy = options.previous_policy === undefined ? undefined : safePolicy(options.previous_policy);
  if (previousPolicy && previousPolicy.id !== candidatePolicy.id) throw new Error("promotion dossier policies must have the same ID");
  const gate = validateRouteGateResult(options.gate);
  const targets = validateTargets(options.targets);
  const compilations = targets.map((target) => compilePolicy(candidatePolicy, target));
  const policyDiff = previousPolicy ? diffPolicies(previousPolicy, candidatePolicy) : undefined;
  const payload: PromotionDossier["payload"] = {
    protocol,
    decision,
    candidate_policy: candidatePolicy,
    ...(previousPolicy ? { previous_policy: previousPolicy, policy_diff: policyDiff } : {}),
    gate,
    compilations,
    promotion: assessPromotion(decision, gate, candidatePolicy),
  };
  const payloadHash = sha256(payload);
  return {
    dossier_version: "0.1",
    created_at: createdAt,
    manifest: { format: "agentroute-promotion-dossier", payload_sha256: payloadHash, root_sha256: rootHash(createdAt, payloadHash) },
    payload,
  };
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function verifyPromotionDossier(value: unknown): PromotionDossierVerification {
  const errors: string[] = [];
  const dossier = value as Partial<PromotionDossier>;
  if (!object(value)) return { valid: false, errors: ["promotion dossier must be an object"], targets: [] };
  if (dossier.dossier_version !== "0.1") errors.push("dossier_version must equal 0.1");
  if (!dossier.created_at || Number.isNaN(Date.parse(dossier.created_at))) errors.push("promotion dossier created_at is invalid");
  if (!dossier.manifest || dossier.manifest.format !== "agentroute-promotion-dossier") errors.push("promotion dossier manifest format is invalid");
  let protocol: ExperimentProtocol | undefined;
  let decision: ExperimentDecision | undefined;
  let candidatePolicy: AgentRoutePolicy | undefined;
  let previousPolicy: AgentRoutePolicy | undefined;
  let gate: RouteGateResult | undefined;
  let targets: PolicyTarget[] = [];
  if (!dossier.payload) errors.push("promotion dossier payload is required");
  else {
    try { protocol = validateExperimentProtocol(dossier.payload.protocol); } catch (error) { errors.push(`protocol: ${(error as Error).message}`); }
    try { decision = validateExperimentDecision(dossier.payload.decision, dossier.payload.protocol); } catch (error) { errors.push(`decision: ${(error as Error).message}`); }
    try {
      candidatePolicy = safePolicy(dossier.payload.candidate_policy);
      if (!canonicalEqual(candidatePolicy, dossier.payload.candidate_policy)) errors.push("candidate policy contains non-portable fields");
    } catch (error) { errors.push(`candidate policy: ${(error as Error).message}`); }
    if (dossier.payload.previous_policy !== undefined) {
      try {
        previousPolicy = safePolicy(dossier.payload.previous_policy);
        if (!canonicalEqual(previousPolicy, dossier.payload.previous_policy)) errors.push("previous policy contains non-portable fields");
      } catch (error) { errors.push(`previous policy: ${(error as Error).message}`); }
    }
    try { gate = validateRouteGateResult(dossier.payload.gate); } catch (error) { errors.push(`gate: ${(error as Error).message}`); }
    try { targets = validateTargets(dossier.payload.compilations?.map((artifact) => artifact.target)); } catch (error) { errors.push(`compilations: ${(error as Error).message}`); }
    if (candidatePolicy && targets.length) {
      const expectedCompilations = targets.map((target) => compilePolicy(candidatePolicy!, target));
      if (!canonicalEqual(expectedCompilations, dossier.payload.compilations)) errors.push("promotion dossier compiler outputs are inconsistent with candidate policy");
    }
    if (previousPolicy && candidatePolicy) {
      if (!dossier.payload.policy_diff || !canonicalEqual(diffPolicies(previousPolicy, candidatePolicy), dossier.payload.policy_diff)) errors.push("promotion dossier policy diff is inconsistent");
    } else if (dossier.payload.policy_diff !== undefined) errors.push("promotion dossier policy diff requires previous_policy");
    if (decision && gate && candidatePolicy && !canonicalEqual(assessPromotion(decision, gate, candidatePolicy), dossier.payload.promotion)) errors.push("promotion dossier verdict is inconsistent");
  }
  if (dossier.payload && dossier.manifest) {
    const payloadHash = sha256(dossier.payload);
    if (dossier.manifest.payload_sha256 !== payloadHash) errors.push("promotion dossier payload SHA-256 mismatch");
    if (dossier.created_at && dossier.manifest.root_sha256 !== rootHash(dossier.created_at, payloadHash)) errors.push("promotion dossier root SHA-256 mismatch");
  }
  return {
    valid: errors.length === 0,
    errors,
    ...(dossier.payload?.promotion?.verdict ? { verdict: dossier.payload.promotion.verdict } : {}),
    ...(dossier.manifest?.root_sha256 ? { root_sha256: dossier.manifest.root_sha256 } : {}),
    ...(protocol ? { protocol_id: protocol.id } : {}),
    ...(candidatePolicy ? { policy_id: `${candidatePolicy.id}@${candidatePolicy.version}` } : {}),
    targets,
  };
}

export function writePromotionDossier(path: string, dossier: PromotionDossier): void {
  writeFileSync(path, canonicalJson(dossier) + "\n");
}

export function loadPromotionDossier(path: string): PromotionDossier {
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const verification = verifyPromotionDossier(value);
  if (!verification.valid) throw new Error(`invalid AgentRoute promotion dossier:\n  - ${verification.errors.join("\n  - ")}`);
  return value as PromotionDossier;
}

const html = (value: unknown): string => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;");

export function renderPromotionDossier(dossier: PromotionDossier): string {
  const verification = verifyPromotionDossier(dossier);
  if (!verification.valid) throw new Error(`cannot render invalid AgentRoute promotion dossier:\n  - ${verification.errors.join("\n  - ")}`);
  const { payload } = dossier;
  const checkRows = payload.decision.checks.map((check) => `<tr><td>${html(check.scope)}</td><td>${html(check.metric)}</td><td><span class="status ${html(check.status)}">${html(check.status)}</span></td><td>${html(check.actual ?? "not measured")}</td><td>${html(check.operator)} ${html(check.threshold)}</td></tr>`).join("");
  const gateRows = payload.gate.metrics.map((metric) => `<tr><td>${html(metric.slice || "global")}</td><td>${html(metric.id)}</td><td><span class="status ${html(metric.status)}">${html(metric.status)}</span></td><td>${html(metric.message)}</td></tr>`).join("");
  const targetCards = payload.compilations.map((artifact) => `<li><strong>${html(artifact.target)}</strong><span>${html(artifact.source.fingerprint)}</span></li>`).join("");
  const reasons = payload.promotion.reasons.map((reason) => `<li>${html(reason)}</li>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AgentRoute Promotion Dossier</title><style>
:root{--paper:#f4f2ed;--panel:#fff;--ink:#182025;--muted:#69747a;--line:#d7d7d1;--pass:#166b4b;--fail:#a33d2d;--wait:#94620c}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:ui-sans-serif,system-ui,sans-serif}main{max-width:1180px;margin:auto;padding:42px 22px 70px}header{display:grid;grid-template-columns:1fr auto;gap:28px;align-items:end;border-bottom:2px solid var(--ink);padding-bottom:24px}.eyebrow{font:700 12px ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}h1{font-size:clamp(42px,7vw,88px);letter-spacing:-.06em;line-height:.88;margin:10px 0 0;max-width:10ch}.verdict{font:800 22px ui-monospace,monospace;text-transform:uppercase;border:2px solid currentColor;border-radius:999px;padding:12px 18px}.verdict.eligible,.status.pass{color:var(--pass)}.verdict.blocked,.status.fail{color:var(--fail)}.verdict.insufficient,.status.insufficient,.status.neutral{color:var(--wait)}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:20px 0}.card,section{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:20px}.card span,.target span{display:block;color:var(--muted);font:12px ui-monospace,monospace;margin-top:6px;overflow-wrap:anywhere}section{margin-top:14px}h2{font-size:18px;margin:0 0 14px}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:10px 8px;border-top:1px solid var(--line);vertical-align:top}.status{font:800 11px ui-monospace,monospace;text-transform:uppercase}.targets{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px;padding:0;list-style:none}.targets li{border:1px solid var(--line);border-radius:12px;padding:12px}.hash{font:11px ui-monospace,monospace;color:var(--muted);overflow-wrap:anywhere}@media(max-width:760px){header{grid-template-columns:1fr}.grid{grid-template-columns:1fr}table{display:block;overflow:auto}}
</style></head><body><main><header><div><div class="eyebrow">AgentRoute / review only / no apply</div><h1>Promotion dossier</h1></div><div class="verdict ${html(payload.promotion.verdict)}">${html(payload.promotion.verdict)}</div></header><div class="grid"><div class="card"><strong>${html(payload.protocol.id)}</strong><span>protocol</span></div><div class="card"><strong>${html(payload.candidate_policy.id)}@${html(payload.candidate_policy.version)}</strong><span>candidate policy</span></div><div class="card"><strong>${html(payload.decision.analysis.arena_runs)}</strong><span>Arena runs</span></div></div><section><h2>Decision reasons</h2><ul>${reasons}</ul></section><section><h2>Experiment checks</h2><table><thead><tr><th>Scope</th><th>Metric</th><th>Status</th><th>Actual</th><th>Requirement</th></tr></thead><tbody>${checkRows}</tbody></table></section><section><h2>Routing quality gate</h2><table><thead><tr><th>Scope</th><th>Metric</th><th>Status</th><th>Evidence</th></tr></thead><tbody>${gateRows}</tbody></table></section><section><h2>Dry-run compiler targets</h2><ul class="targets">${targetCards}</ul></section><section><h2>Integrity</h2><div class="hash">Protocol ${html(payload.decision.protocol_sha256)}<br>Evidence ${html(payload.decision.evidence_sha256)}<br>Dossier ${html(dossier.manifest.root_sha256)}</div></section></main></body></html>`;
}
