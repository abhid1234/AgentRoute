import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEvidenceCapsule, verifyEvidenceCapsule } from "./capsule.js";
import { canonicalJson, sha256 } from "./canonical.js";
import { listConnectors } from "./connectors.js";
import type { AgentRouteConnector } from "./connectors.js";
import { createOperationsReview, renderOperationsReview, verifyOperationsReview } from "./operations-review.js";
import { decideReplayExperiment } from "./experiment-protocol.js";
import { createPromotionDossier, verifyPromotionDossier } from "./promotion-dossier.js";
import { evaluateRouteGate } from "./quality-gate.js";
import type { RouteGateConfig } from "./quality-gate.js";
import { fixtureReplayExecutor, runReplayArena } from "./replay-arena.js";
import type { ReplayArenaTask, ReplayFixture } from "./replay-arena.js";
import { appendReliabilityReview, createReliabilityTimeline, renderReliabilityTimeline, verifyReliabilityTimeline } from "./reliability-timeline.js";
import { createRouteDecision, createRouteObservation, foldRouteRecords, loadRouteRecords } from "./route.js";
import { routeToTelemetry } from "./route-to-otel.js";
import type { TelemetryProfile } from "./route-to-otel.js";
import type { RouteRecord } from "./route-types.js";

export interface ProofArtifact {
  path: string;
  media_type: string;
  sha256: string;
}

export interface ProofManifest {
  proof_version: "0.1";
  claim_scope: "offline_conformance";
  evidence_label: "illustrative";
  generated_at: string;
  generator: { name: "agentroute"; version: "0.2.0" };
  artifacts: ProofArtifact[];
  root_sha256: string;
}

export interface ProofVerification {
  valid: boolean;
  errors: string[];
  root_sha256?: string;
  artifact_count: number;
  dossier_verdict?: string;
  operations_status?: string;
  timeline_status?: string;
  connector_count?: number;
}

export interface BuildProofPackOptions {
  output: string;
  force?: boolean;
}

const GENERATED_AT = "2026-08-25T00:00:00.000Z";
const BASELINE_AT = "2026-08-24T23:00:00.000Z";
const RUN_ID = "agentroute-public-proof-v0-2";
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SOURCE_INPUTS = [
  ["input-cases.json", "examples/public-proof.cases.json"],
  ["input-experiment-protocol.json", "examples/public-proof.protocol.json"],
  ["input-candidate-policy.json", "examples/evidence-suite.policy.json"],
  ["input-quality-gate.json", "examples/public-proof.gate.json"],
  ["input-operations-drift.json", "examples/public-proof.drift.json"],
  ["input-routing-slo.json", "examples/public-proof.slo.json"],
  ["input-resilience-scenario.json", "examples/public-proof.scenario.json"],
] as const;

const ARTIFACT_FILES = [
  ...SOURCE_INPUTS.map(([output]) => output),
  "input-route-ledger.jsonl",
  "input-replay-tasks.json",
  "input-replay-fixtures.json",
  "operations-baseline.route.jsonl",
  "operations-current.route.jsonl",
  "inputs.json",
  "replay.route.jsonl",
  "arena-report.json",
  "experiment-decision.json",
  "quality-gate.json",
  "promotion.arpromote",
  "promotion-verification.json",
  "evidence.arcap",
  "capsule-verification.json",
  "otel-genai.json",
  "openinference.json",
  "connector-catalog.json",
  "operations.arops",
  "operations-verification.json",
  "operations-review.html",
  "reliability.arhistory",
  "reliability-verification.json",
  "reliability.html",
  "index.html",
] as const;

const EXPECTED_FILES = new Set<string>([...ARTIFACT_FILES, "proof-manifest.json"]);
const SAFE_ARTIFACT_PATH = /^[a-z0-9][a-z0-9.-]*$/;

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const writeCanonical = (path: string, value: unknown): void => writeFileSync(path, canonicalJson(value) + "\n");
const mediaType = (path: string): string => path.endsWith(".html") ? "text/html" : path.endsWith(".jsonl") ? "application/x-ndjson" : "application/json";
const escapeHtml = (value: unknown): string => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;");
const labelIllustrativeHtml = (html: string): string => html.replace("<body>", "<body><div style=\"padding:10px 18px;text-align:center;background:#fbbf24;color:#111827;font:800 12px ui-monospace,monospace;letter-spacing:.06em\">Illustrative offline conformance evidence — not production telemetry or a live provider claim.</div>");

function ensureOutputDirectory(path: string, force: boolean): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
    return;
  }
  if (!statSync(path).isDirectory()) throw new Error(`${path} exists and is not a directory`);
  const entries = readdirSync(path);
  if (!entries.length) return;
  if (!force) throw new Error(`${path} is not empty; pass --force to replace a previous proof pack`);
  const unknown = entries.filter((entry) => !EXPECTED_FILES.has(entry));
  if (unknown.length) throw new Error(`${path} contains files AgentRoute will not overwrite: ${unknown.sort().join(", ")}`);
  const nonFiles = entries.filter((entry) => !statSync(join(path, entry)).isFile());
  if (nonFiles.length) throw new Error(`${path} contains non-file entries AgentRoute will not overwrite: ${nonFiles.sort().join(", ")}`);
}

function manifestRoot(manifest: Omit<ProofManifest, "root_sha256">): string {
  return sha256(manifest);
}

function renderProofReport(
  decision: ReturnType<typeof decideReplayExperiment>,
  dossier: ReturnType<typeof createPromotionDossier>,
  gate: ReturnType<typeof evaluateRouteGate>,
  operations: ReturnType<typeof createOperationsReview>,
  timeline: ReturnType<typeof createReliabilityTimeline>,
  connectors: AgentRouteConnector[],
  capsuleRoot: string,
): string {
  const checks = decision.checks.map((check) => `<tr><td>${escapeHtml(check.scope)}</td><td>${escapeHtml(check.metric)}</td><td class="${escapeHtml(check.status)}">${escapeHtml(check.status)}</td><td>${escapeHtml(check.message)}</td></tr>`).join("");
  const artifacts = ARTIFACT_FILES.filter((path) => path !== "index.html").map((path) => `<li><a href="${escapeHtml(path)}">${escapeHtml(path)}</a></li>`).join("");
  const availableConnectors = connectors.filter((connector) => connector.status === "available").length;
  const targetCount = dossier.payload.compilations.length;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AgentRoute Public Proof Pack</title><style>
:root{--paper:#f2f0e8;--ink:#152126;--muted:#65757b;--panel:#fff;--line:#d4d8d2;--pass:#08775a;--fail:#ae3f32;--attention:#9a5b00}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 90% 0,#d9eee7 0,transparent 32%),var(--paper);color:var(--ink);font-family:ui-sans-serif,system-ui,sans-serif}main{max-width:1160px;margin:auto;padding:52px 22px 84px}.eyebrow{font:750 12px ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}h1{font-size:clamp(48px,8vw,96px);letter-spacing:-.065em;line-height:.9;margin:12px 0 18px;max-width:10ch}.lede{max-width:800px;font-size:19px;line-height:1.55}.warning{border:2px solid var(--ink);border-radius:16px;padding:16px 18px;margin:28px 0;font-weight:800}.grid,.explore{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px}.card,section,.link-card{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:20px}.card strong{font-size:25px}.card span,.link-card span{display:block;color:var(--muted);font:12px ui-monospace,monospace;margin-top:6px}.link-card{text-decoration:none;transition:transform .15s ease}.link-card:hover{transform:translateY(-2px)}.link-card b{font-size:18px}section{margin-top:14px}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:10px 8px;border-top:1px solid var(--line);vertical-align:top}.pass,.eligible,.clear{color:var(--pass);font-weight:800}.fail,.critical{color:var(--fail);font-weight:800}.attention{color:var(--attention);font-weight:800}.hash{font:11px ui-monospace,monospace;overflow-wrap:anywhere;color:var(--muted)}ul.artifacts{columns:3;padding-left:20px}a{color:var(--ink)}@media(max-width:760px){ul.artifacts{columns:1}table{display:block;overflow:auto}}
</style></head><body><main><div class="eyebrow">AgentRoute / v0.2 / launch showcase</div><h1>Prove every route.</h1><p class="lede">One deterministic workspace from frozen routing receipts through measured replay, preregistered promotion, operational SLOs, resilience review, and longitudinal evidence.</p><div class="warning">Illustrative offline conformance evidence — not a live model benchmark or provider-performance claim.</div><div class="grid"><div class="card"><strong class="${escapeHtml(decision.status)}">${escapeHtml(decision.status)}</strong><span>experiment decision</span></div><div class="card"><strong class="${escapeHtml(gate.status)}">${escapeHtml(gate.status)}</strong><span>quality gate</span></div><div class="card"><strong class="${escapeHtml(dossier.payload.promotion.verdict)}">${escapeHtml(dossier.payload.promotion.verdict)}</strong><span>promotion / no apply</span></div><div class="card"><strong class="${escapeHtml(operations.payload.assessment.status)}">${escapeHtml(operations.payload.assessment.status)}</strong><span>operations assessment</span></div><div class="card"><strong>${timeline.summary.reviews}</strong><span>hash-chained reviews</span></div><div class="card"><strong>${availableConnectors}/${connectors.length}</strong><span>connectors fully ready</span></div></div><section><h2>Open the product</h2><div class="explore"><a class="link-card" href="operations-review.html"><b>Operations review →</b><span>drift + SLO + outage scenario</span></a><a class="link-card" href="reliability.html"><b>Reliability timeline →</b><span>baseline to proposed rollout</span></a><a class="link-card" href="promotion.arpromote"><b>Promotion dossier →</b><span>${targetCount} dry-run policy targets</span></a><a class="link-card" href="evidence.arcap"><b>Evidence capsule →</b><span>portable sanitized receipts</span></a><a class="link-card" href="connector-catalog.json"><b>Connector catalog →</b><span>capability-level readiness</span></a><a class="link-card" href="proof-manifest.json"><b>Proof manifest →</b><span>exact files and SHA-256 roots</span></a></div></section><section><h2>Why attention can be healthy</h2><p>The experiment and quality gate support the proposed policy, while the provider-outage scenario still changes all twelve routes to their recorded fallback. AgentRoute keeps that operational impact visible instead of turning an eligible promotion into an unconditional “safe” claim.</p></section><section><h2>Preregistered checks</h2><table><thead><tr><th>Scope</th><th>Metric</th><th>Status</th><th>Evidence</th></tr></thead><tbody>${checks}</tbody></table></section><section><h2>Evidence chain</h2><ol><li>Frozen inputs generate full-fidelity baseline and proposed routing ledgers.</li><li>Fixture-only replay measures both candidates under hard request and cost limits.</li><li>The experiment, quality gate, drift contract, and routing SLO are evaluated independently.</li><li>The dossier compiles review-only vendor configurations; it never applies them.</li><li>The outage scenario uses only recorded fallback evidence and calls no provider.</li><li>The operations review, reliability timeline, capsule, and manifest bind the complete sanitized result.</li></ol></section><section><h2>All ${ARTIFACT_FILES.length} bound artifacts</h2><ul class="artifacts">${artifacts}</ul></section><section><h2>Integrity anchors</h2><div class="hash">Experiment: ${escapeHtml(decision.evidence_sha256)}<br>Dossier: ${escapeHtml(dossier.manifest.root_sha256)}<br>Operations: ${escapeHtml(operations.manifest.root_sha256)}<br>Timeline: ${escapeHtml(timeline.manifest.root_sha256)}<br>Capsule: ${escapeHtml(capsuleRoot)}</div></section></main></body></html>`;
}

function sourcePath(relative: string): string {
  const path = join(PACKAGE_ROOT, relative);
  if (!existsSync(path)) throw new Error(`bundled proof input is missing: ${relative}`);
  return path;
}

interface PublicProofMetrics { quality: number; latency_ms: number; cost_usd: number }
interface PublicProofCase { id: string; task_type: string; baseline: PublicProofMetrics; challenger: PublicProofMetrics }

function validateMetrics(value: unknown, label: string): PublicProofMetrics {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} metrics are required`);
  const metrics = value as Record<string, unknown>;
  if (typeof metrics.quality !== "number" || !Number.isFinite(metrics.quality) || metrics.quality < 0 || metrics.quality > 1) throw new Error(`${label} quality must be 0..1`);
  for (const key of ["latency_ms", "cost_usd"] as const) if (typeof metrics[key] !== "number" || !Number.isFinite(metrics[key]) || metrics[key] < 0) throw new Error(`${label} ${key} must be non-negative`);
  return metrics as unknown as PublicProofMetrics;
}

function buildFrozenInputs(value: unknown): { cases: PublicProofCase[]; records: RouteRecord[]; tasks: ReplayArenaTask[]; fixtures: ReplayFixture[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("public proof cases must be an object");
  const input = value as Record<string, unknown>;
  if (input.case_version !== "0.1" || input.evidence_label !== "illustrative" || !Array.isArray(input.cases) || input.cases.length < 10) throw new Error("public proof requires at least ten illustrative v0.1 cases");
  const ids = new Set<string>();
  const cases = input.cases.map((raw, index): PublicProofCase => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`public proof case ${index} must be an object`);
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== "string" || !/^[a-z0-9][a-z0-9_]*$/.test(item.id) || ids.has(item.id)) throw new Error(`public proof case ${index} has an invalid or duplicate id`);
    ids.add(item.id);
    if (typeof item.task_type !== "string" || !/^[a-z][a-z0-9_]*$/.test(item.task_type)) throw new Error(`${item.id}: task_type is invalid`);
    return { id: item.id, task_type: item.task_type, baseline: validateMetrics(item.baseline, `${item.id}.baseline`), challenger: validateMetrics(item.challenger, `${item.id}.challenger`) };
  });
  const records: RouteRecord[] = cases.map((item) => createRouteDecision({
    route_id: `route_public_${item.id}`,
    created_at: GENERATED_AT,
    task: { type: item.task_type, fingerprint: `sha256:illustrative-${item.id}` },
    router: { name: "agentroute-public-proof", version: "0.2.0", policy_id: "balanced-code-review", policy_version: "1.0.0" },
    source: { kind: "native", fidelity: "full", event_id: RUN_ID },
    candidates: [
      { id: "deep-review", model: "frontier-review-model", provider: "provider-a", eligible: true, estimates: { ...item.baseline } },
      { id: "fast-review", model: "fast-review-model", provider: "provider-b", eligible: true, estimates: { ...item.challenger } },
    ],
    criteria: { max_cost_usd: 0.1, max_latency_ms: 3000, min_quality: 0.8 },
    selection: { candidate_id: "deep-review", reason: "illustrative frozen baseline selection" },
  }));
  const tasks: ReplayArenaTask[] = cases.map((item) => ({ route_id: `route_public_${item.id}`, task_ref: `task-pack://public-proof/${item.id}`, candidate_ids: ["deep-review", "fast-review"] }));
  const fixtures: ReplayFixture[] = cases.flatMap((item) => ([
    { route_id: `route_public_${item.id}`, candidate_id: "deep-review", estimated_cost_usd: item.baseline.cost_usd, outcome: { status: "success", ...item.baseline } },
    { route_id: `route_public_${item.id}`, candidate_id: "fast-review", estimated_cost_usd: item.challenger.cost_usd, outcome: { status: "success", ...item.challenger } },
  ]));
  return { cases, records, tasks, fixtures };
}

function operationalLedger(cases: PublicProofCase[], selected: "deep-review" | "fast-review", recordedAt: string): RouteRecord[] {
  const selectedProvider = selected === "deep-review" ? "provider-a" : "provider-b";
  const selectedModel = selected === "deep-review" ? "frontier-review-model" : "fast-review-model";
  const fallback = selected === "deep-review" ? "fast-review" : "deep-review";
  return cases.flatMap((item) => {
    const routeId = `route_operations_${item.id}`;
    const metrics = selected === "deep-review" ? item.baseline : item.challenger;
    const decision = createRouteDecision({
      route_id: routeId,
      created_at: recordedAt,
      task: { type: item.task_type, fingerprint: `sha256:illustrative-${item.id}` },
      router: { name: "agentroute-public-proof", version: "0.2.0", policy_id: "balanced-code-review", policy_version: selected === "deep-review" ? "1.0.0" : "1.1.0" },
      source: { kind: "native", fidelity: "full", event_id: `public-proof-operations-${selected}` },
      candidates: [
        { id: "deep-review", model: "frontier-review-model", provider: "provider-a", eligible: true, estimates: { ...item.baseline } },
        { id: "fast-review", model: "fast-review-model", provider: "provider-b", eligible: true, estimates: { ...item.challenger } },
      ],
      criteria: { max_cost_usd: 0.1, max_latency_ms: 3000, min_quality: 0.8 },
      selection: { candidate_id: selected, reason: "illustrative frozen operational selection", fallback_order: [fallback] },
      extensions: { demo_fixture: "illustrative-only" },
    });
    const observation = createRouteObservation({
      route_id: routeId,
      observation_id: `obs_operations_${selected === "deep-review" ? "baseline" : "proposed"}_${item.id}`,
      observed_at: recordedAt,
      outcome: { status: "success", actual_model: selectedModel, actual_provider: selectedProvider, ...metrics },
      extensions: { demo_fixture: "illustrative-only" },
    });
    return [decision, observation];
  });
}

function candidateLedger(records: RouteRecord[], candidateId: string): RouteRecord[] {
  const routeIds = new Set(records.flatMap((record) => record.record_type === "decision" && record.selection.candidate_id === candidateId ? [record.route_id] : []));
  return records.filter((record) => routeIds.has(record.route_id));
}

export async function buildProofPack(options: BuildProofPackOptions): Promise<ProofManifest> {
  ensureOutputDirectory(options.output, options.force === true);
  const sources: Array<{ path: string; source: string; sha256: string }> = SOURCE_INPUTS.map(([output, source]) => {
    const content = readFileSync(sourcePath(source), "utf8");
    writeFileSync(join(options.output, output), content);
    return { path: output, source, sha256: sha256(content) };
  });
  const frozen = buildFrozenInputs(readJson(join(options.output, "input-cases.json")));
  writeFileSync(join(options.output, "input-route-ledger.jsonl"), frozen.records.map(canonicalJson).join("\n") + "\n");
  writeCanonical(join(options.output, "input-replay-tasks.json"), { tasks: frozen.tasks });
  writeCanonical(join(options.output, "input-replay-fixtures.json"), { fixtures: frozen.fixtures });
  const operationsBaseline = operationalLedger(frozen.cases, "deep-review", BASELINE_AT);
  const operationsCurrent = operationalLedger(frozen.cases, "fast-review", GENERATED_AT);
  writeFileSync(join(options.output, "operations-baseline.route.jsonl"), operationsBaseline.map(canonicalJson).join("\n") + "\n");
  writeFileSync(join(options.output, "operations-current.route.jsonl"), operationsCurrent.map(canonicalJson).join("\n") + "\n");
  for (const path of ["input-route-ledger.jsonl", "input-replay-tasks.json", "input-replay-fixtures.json", "operations-baseline.route.jsonl", "operations-current.route.jsonl"]) sources.push({ path, source: "generated-from:input-cases.json", sha256: sha256(readFileSync(join(options.output, path), "utf8")) });
  writeCanonical(join(options.output, "inputs.json"), {
    proof_input_version: "0.1",
    claim_scope: "offline_conformance",
    evidence_label: "illustrative",
    generated_at: GENERATED_AT,
    run_id: RUN_ID,
    limits: { max_requests: 24, max_cost_usd: 1 },
    sources: sources.sort((left, right) => left.path.localeCompare(right.path)),
  });

  const records = loadRouteRecords(join(options.output, "input-route-ledger.jsonl"));
  const protocol = readJson(join(options.output, "input-experiment-protocol.json"));
  const policy = readJson(join(options.output, "input-candidate-policy.json"));
  const gateConfig = readJson(join(options.output, "input-quality-gate.json")) as RouteGateConfig;
  const arena = await runReplayArena(records, {
    run_id: RUN_ID,
    generated_at: GENERATED_AT,
    tasks: frozen.tasks,
    limits: { max_requests: 24, max_cost_usd: 1 },
    executor: fixtureReplayExecutor(frozen.fixtures),
  });
  writeFileSync(join(options.output, "replay.route.jsonl"), arena.records.map(canonicalJson).join("\n") + "\n");
  writeCanonical(join(options.output, "arena-report.json"), arena);

  const decision = decideReplayExperiment(arena.records, protocol, GENERATED_AT);
  const gate = evaluateRouteGate(candidateLedger(arena.records, "deep-review"), candidateLedger(arena.records, "fast-review"), gateConfig);
  const dossier = createPromotionDossier({
    protocol,
    decision,
    candidate_policy: policy,
    gate,
    targets: ["native", "openrouter", "litellm", "portkey", "vercel-ai-gateway"],
    created_at: GENERATED_AT,
  });
  const dossierVerification = verifyPromotionDossier(dossier);
  const capsule = createEvidenceCapsule(arena.records, [policy], GENERATED_AT);
  const capsuleVerification = verifyEvidenceCapsule(capsule);
  const driftConfig = readJson(join(options.output, "input-operations-drift.json"));
  const sloConfig = readJson(join(options.output, "input-routing-slo.json"));
  const scenario = readJson(join(options.output, "input-resilience-scenario.json"));
  const baselineOperations = createOperationsReview({
    baseline_records: operationsBaseline,
    current_records: operationsBaseline,
    drift_config: driftConfig as Parameters<typeof createOperationsReview>[0]["drift_config"],
    slo_config: sloConfig,
    scenarios: [],
    created_at: BASELINE_AT,
  });
  const operations = createOperationsReview({
    baseline_records: operationsBaseline,
    current_records: operationsCurrent,
    drift_config: driftConfig as Parameters<typeof createOperationsReview>[0]["drift_config"],
    slo_config: sloConfig,
    scenarios: [scenario],
    created_at: GENERATED_AT,
  });
  const operationsVerification = verifyOperationsReview(operations);
  const timeline = appendReliabilityReview(createReliabilityTimeline(baselineOperations), operations).timeline;
  const timelineVerification = verifyReliabilityTimeline(timeline);
  const connectors = listConnectors();
  writeCanonical(join(options.output, "experiment-decision.json"), decision);
  writeCanonical(join(options.output, "quality-gate.json"), gate);
  writeCanonical(join(options.output, "promotion.arpromote"), dossier);
  writeCanonical(join(options.output, "promotion-verification.json"), dossierVerification);
  writeCanonical(join(options.output, "evidence.arcap"), capsule);
  writeCanonical(join(options.output, "capsule-verification.json"), capsuleVerification);
  writeCanonical(join(options.output, "connector-catalog.json"), connectors);
  writeCanonical(join(options.output, "operations.arops"), operations);
  writeCanonical(join(options.output, "operations-verification.json"), operationsVerification);
  writeFileSync(join(options.output, "operations-review.html"), labelIllustrativeHtml(renderOperationsReview(operations)));
  writeCanonical(join(options.output, "reliability.arhistory"), timeline);
  writeCanonical(join(options.output, "reliability-verification.json"), timelineVerification);
  writeFileSync(join(options.output, "reliability.html"), labelIllustrativeHtml(renderReliabilityTimeline(timeline)));

  const states = [...foldRouteRecords(arena.records).values()];
  const exportProfile = (profile: TelemetryProfile): Record<string, unknown>[] => states.map((state) => routeToTelemetry(state, profile));
  writeCanonical(join(options.output, "otel-genai.json"), exportProfile("otel-genai"));
  writeCanonical(join(options.output, "openinference.json"), exportProfile("openinference"));
  writeFileSync(join(options.output, "index.html"), renderProofReport(decision, dossier, gate, operations, timeline, connectors, capsule.manifest.root_sha256));

  const artifacts = [...ARTIFACT_FILES].sort().map((path): ProofArtifact => ({
    path,
    media_type: mediaType(path),
    sha256: sha256(readFileSync(join(options.output, path), "utf8")),
  }));
  const body: Omit<ProofManifest, "root_sha256"> = {
    proof_version: "0.1",
    claim_scope: "offline_conformance",
    evidence_label: "illustrative",
    generated_at: GENERATED_AT,
    generator: { name: "agentroute", version: "0.2.0" },
    artifacts,
  };
  const manifest: ProofManifest = { ...body, root_sha256: manifestRoot(body) };
  writeCanonical(join(options.output, "proof-manifest.json"), manifest);
  return manifest;
}

export function verifyProofPack(path: string): ProofVerification {
  const errors: string[] = [];
  if (!existsSync(path) || !statSync(path).isDirectory()) return { valid: false, errors: ["proof pack directory does not exist"], artifact_count: 0 };
  let manifest: ProofManifest;
  try {
    const value = readJson(join(path, "proof-manifest.json"));
    if (!object(value)) return { valid: false, errors: ["proof manifest must be an object"], artifact_count: 0 };
    manifest = value as unknown as ProofManifest;
  } catch (error) { return { valid: false, errors: [`proof manifest: ${(error as Error).message}`], artifact_count: 0 }; }
  if (manifest.proof_version !== "0.1" || manifest.claim_scope !== "offline_conformance" || manifest.evidence_label !== "illustrative") errors.push("proof manifest contract is invalid");
  if (typeof manifest.generated_at !== "string" || Number.isNaN(Date.parse(manifest.generated_at)) || manifest.generator?.name !== "agentroute" || typeof manifest.generator?.version !== "string") errors.push("proof manifest generator metadata is invalid");
  if (!Array.isArray(manifest.artifacts) || !manifest.artifacts.length) errors.push("proof manifest artifacts are required");
  const artifacts: ProofArtifact[] = [];
  for (const [index, raw] of (Array.isArray(manifest.artifacts) ? manifest.artifacts : []).entries()) {
    if (!object(raw) || typeof raw.path !== "string" || typeof raw.media_type !== "string" || typeof raw.sha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(raw.sha256)) { errors.push(`proof manifest artifact ${index} is invalid`); continue; }
    artifacts.push(raw as unknown as ProofArtifact);
  }
  const paths = artifacts.map((artifact) => artifact.path);
  if (new Set(paths).size !== paths.length) errors.push("proof manifest artifact paths must be unique");
  if (paths.some((entry) => !SAFE_ARTIFACT_PATH.test(entry))) errors.push("proof manifest artifact paths must be flat safe filenames");
  const body: Omit<ProofManifest, "root_sha256"> = { proof_version: manifest.proof_version, claim_scope: manifest.claim_scope, evidence_label: manifest.evidence_label, generated_at: manifest.generated_at, generator: manifest.generator, artifacts };
  if (manifest.root_sha256 !== manifestRoot(body)) errors.push("proof manifest root SHA-256 mismatch");
  const actualFiles = readdirSync(path).sort();
  const declaredFiles = [...paths, "proof-manifest.json"].sort();
  if (canonicalJson(declaredFiles) !== canonicalJson([...EXPECTED_FILES].sort())) errors.push("proof manifest does not declare the required v0.1 artifact set");
  if (canonicalJson(actualFiles) !== canonicalJson(declaredFiles)) errors.push("proof pack files do not exactly match the manifest");
  for (const artifact of artifacts) {
    if (!SAFE_ARTIFACT_PATH.test(artifact.path)) continue;
    const artifactPath = join(path, artifact.path);
    if (!existsSync(artifactPath) || !statSync(artifactPath).isFile()) { errors.push(`missing artifact: ${artifact.path}`); continue; }
    if (artifact.sha256 !== sha256(readFileSync(artifactPath, "utf8"))) errors.push(`artifact SHA-256 mismatch: ${artifact.path}`);
  }
  let dossierVerdict: string | undefined;
  let operationsStatus: string | undefined;
  let operationsRoot: string | undefined;
  let timelineStatus: string | undefined;
  let connectorCount: number | undefined;
  try {
    const computed = verifyPromotionDossier(readJson(join(path, "promotion.arpromote")));
    const stored = readJson(join(path, "promotion-verification.json"));
    if (!computed.valid || canonicalJson(computed) !== canonicalJson(stored)) errors.push("promotion dossier verification is invalid or stale");
    dossierVerdict = computed.verdict;
  } catch (error) { errors.push(`promotion dossier verification: ${(error as Error).message}`); }
  try {
    const computed = verifyEvidenceCapsule(readJson(join(path, "evidence.arcap")));
    const stored = readJson(join(path, "capsule-verification.json"));
    if (!computed.valid || canonicalJson(computed) !== canonicalJson(stored)) errors.push("evidence capsule verification is invalid or stale");
  } catch (error) { errors.push(`evidence capsule verification: ${(error as Error).message}`); }
  try {
    const operationsValue = readJson(join(path, "operations.arops"));
    const computed = verifyOperationsReview(operationsValue);
    const stored = readJson(join(path, "operations-verification.json"));
    if (!computed.valid || canonicalJson(computed) !== canonicalJson(stored)) errors.push("operations review verification is invalid or stale");
    operationsStatus = computed.status;
    if (object(operationsValue) && object(operationsValue.manifest) && typeof operationsValue.manifest.root_sha256 === "string") operationsRoot = operationsValue.manifest.root_sha256;
  } catch (error) { errors.push(`operations review verification: ${(error as Error).message}`); }
  try {
    const timelineValue = readJson(join(path, "reliability.arhistory"));
    const computed = verifyReliabilityTimeline(timelineValue);
    const stored = readJson(join(path, "reliability-verification.json"));
    if (!computed.valid || canonicalJson(computed) !== canonicalJson(stored)) errors.push("reliability timeline verification is invalid or stale");
    timelineStatus = computed.current_status;
    if (object(timelineValue) && Array.isArray(timelineValue.entries) && timelineValue.entries.length) {
      const finalEntry = timelineValue.entries[timelineValue.entries.length - 1];
      if (!object(finalEntry) || finalEntry.review_root_sha256 !== operationsRoot) errors.push("reliability timeline head does not bind the packaged operations review");
    }
  } catch (error) { errors.push(`reliability timeline verification: ${(error as Error).message}`); }
  try {
    const connectors = readJson(join(path, "connector-catalog.json"));
    if (canonicalJson(connectors) !== canonicalJson(listConnectors())) errors.push("connector catalog does not match the built-in registry");
    connectorCount = Array.isArray(connectors) ? connectors.length : undefined;
  } catch (error) { errors.push(`connector catalog verification: ${(error as Error).message}`); }
  for (const telemetry of ["otel-genai.json", "openinference.json"]) {
    try {
      const value = readFileSync(join(path, telemetry), "utf8").toLowerCase();
      const forbidden = ["input.messages", "output.messages", "prompt", "response.content", "endpoint", "authorization", "extensions"];
      for (const marker of forbidden) if (value.includes(marker)) errors.push(`${telemetry} contains forbidden content marker: ${marker}`);
    } catch (error) { errors.push(`${telemetry}: ${(error as Error).message}`); }
  }
  for (const report of ["index.html", "operations-review.html", "reliability.html"]) {
    try {
      const html = readFileSync(join(path, report), "utf8");
      const lower = html.toLowerCase();
      if (!html.includes("Illustrative offline conformance evidence")) errors.push(`${report} is missing its evidence limitation`);
      if (lower.includes("<script") || lower.includes("https://") || lower.includes("http://")) errors.push(`${report} contains a script or remote asset`);
    } catch (error) { errors.push(`${report}: ${(error as Error).message}`); }
  }
  return {
    valid: errors.length === 0,
    errors,
    root_sha256: manifest.root_sha256,
    artifact_count: artifacts.length,
    ...(dossierVerdict ? { dossier_verdict: dossierVerdict } : {}),
    ...(operationsStatus ? { operations_status: operationsStatus } : {}),
    ...(timelineStatus ? { timeline_status: timelineStatus } : {}),
    ...(connectorCount !== undefined ? { connector_count: connectorCount } : {}),
  };
}
