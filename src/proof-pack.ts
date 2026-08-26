import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEvidenceCapsule, verifyEvidenceCapsule } from "./capsule.js";
import { canonicalJson, sha256 } from "./canonical.js";
import { decideReplayExperiment } from "./experiment-protocol.js";
import { createPromotionDossier, verifyPromotionDossier } from "./promotion-dossier.js";
import { evaluateRouteGate } from "./quality-gate.js";
import type { RouteGateConfig } from "./quality-gate.js";
import { fixtureReplayExecutor, runReplayArena } from "./replay-arena.js";
import type { ReplayArenaTask, ReplayFixture } from "./replay-arena.js";
import { foldRouteRecords, loadRouteRecords } from "./route.js";
import { routeToTelemetry } from "./route-to-otel.js";
import type { TelemetryProfile } from "./route-to-otel.js";

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
}

export interface BuildProofPackOptions {
  output: string;
  force?: boolean;
}

const GENERATED_AT = "2026-08-25T00:00:00.000Z";
const RUN_ID = "agentroute-public-proof-v0-2";
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const INPUTS = [
  ["input-route-ledger.jsonl", "examples/model-routing.route.jsonl"],
  ["input-replay-tasks.json", "examples/evidence-suite.replay-tasks.json"],
  ["input-replay-fixtures.json", "examples/evidence-suite.replay-fixtures.json"],
  ["input-experiment-protocol.json", "examples/promotion-dossier.protocol.json"],
  ["input-candidate-policy.json", "examples/evidence-suite.policy.json"],
  ["input-quality-gate.json", "examples/evidence-suite.gate.json"],
] as const;

const ARTIFACT_FILES = [
  ...INPUTS.map(([output]) => output),
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
  "index.html",
] as const;

const EXPECTED_FILES = new Set<string>([...ARTIFACT_FILES, "proof-manifest.json"]);

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const writeCanonical = (path: string, value: unknown): void => writeFileSync(path, canonicalJson(value) + "\n");
const mediaType = (path: string): string => path.endsWith(".html") ? "text/html" : path.endsWith(".jsonl") ? "application/x-ndjson" : "application/json";
const escapeHtml = (value: unknown): string => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;");

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

function renderProofReport(decision: ReturnType<typeof decideReplayExperiment>, dossier: ReturnType<typeof createPromotionDossier>, gate: ReturnType<typeof evaluateRouteGate>, capsuleRoot: string): string {
  const checks = decision.checks.map((check) => `<tr><td>${escapeHtml(check.scope)}</td><td>${escapeHtml(check.metric)}</td><td class="${escapeHtml(check.status)}">${escapeHtml(check.status)}</td><td>${escapeHtml(check.message)}</td></tr>`).join("");
  const artifacts = ARTIFACT_FILES.filter((path) => path !== "index.html").map((path) => `<li><a href="${escapeHtml(path)}">${escapeHtml(path)}</a></li>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AgentRoute Public Proof Pack</title><style>
:root{--paper:#f6f3ea;--ink:#172126;--muted:#66747a;--panel:#fff;--line:#d8d8d0;--pass:#08775a;--fail:#ae3f32}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:ui-sans-serif,system-ui,sans-serif}main{max-width:1120px;margin:auto;padding:48px 22px 80px}.eyebrow{font:700 12px ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}h1{font-size:clamp(46px,8vw,92px);letter-spacing:-.065em;line-height:.9;margin:12px 0 18px;max-width:10ch}.lede{max-width:760px;font-size:19px;line-height:1.55}.warning{border:2px solid var(--ink);border-radius:16px;padding:16px 18px;margin:28px 0;font-weight:800}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.card,section{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:20px}.card strong{font-size:24px}.card span{display:block;color:var(--muted);font:12px ui-monospace,monospace;margin-top:6px}section{margin-top:14px}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:10px 8px;border-top:1px solid var(--line);vertical-align:top}.pass{color:var(--pass);font-weight:800}.fail{color:var(--fail);font-weight:800}.hash{font:11px ui-monospace,monospace;overflow-wrap:anywhere;color:var(--muted)}ul.artifacts{columns:2;padding-left:20px}a{color:var(--ink)}@media(max-width:760px){.grid{grid-template-columns:1fr}ul.artifacts{columns:1}table{display:block;overflow:auto}}
</style></head><body><main><div class="eyebrow">AgentRoute / v0.2 / reproducible evidence</div><h1>Public Proof Pack</h1><p class="lede">A deterministic chain from frozen routing receipts through replay, preregistered evaluation, quality gates, and review-only policy promotion.</p><div class="warning">Illustrative offline conformance evidence — not a live model benchmark or provider-performance claim.</div><div class="grid"><div class="card"><strong>${escapeHtml(decision.status)}</strong><span>experiment decision</span></div><div class="card"><strong>${escapeHtml(gate.status)}</strong><span>quality gate</span></div><div class="card"><strong>${escapeHtml(dossier.payload.promotion.verdict)}</strong><span>promotion verdict / no apply</span></div></div><section><h2>Preregistered checks</h2><table><thead><tr><th>Scope</th><th>Metric</th><th>Status</th><th>Evidence</th></tr></thead><tbody>${checks}</tbody></table></section><section><h2>Evidence chain</h2><ol><li>Frozen inputs are copied byte-for-byte and hashed.</li><li>Fixture-only replay produces conformant candidate receipts under hard request and cost limits.</li><li>The experiment protocol and route gate are evaluated independently.</li><li>The dossier compiles review-only vendor configurations; it never applies them.</li><li>The capsule and manifest bind the sanitized records and outputs.</li></ol></section><section><h2>Artifacts</h2><ul class="artifacts">${artifacts}</ul></section><section><h2>Integrity anchors</h2><div class="hash">Experiment: ${escapeHtml(decision.evidence_sha256)}<br>Dossier: ${escapeHtml(dossier.manifest.root_sha256)}<br>Capsule: ${escapeHtml(capsuleRoot)}</div></section></main></body></html>`;
}

function sourcePath(relative: string): string {
  const path = join(PACKAGE_ROOT, relative);
  if (!existsSync(path)) throw new Error(`bundled proof input is missing: ${relative}`);
  return path;
}

export async function buildProofPack(options: BuildProofPackOptions): Promise<ProofManifest> {
  ensureOutputDirectory(options.output, options.force === true);
  const sources = INPUTS.map(([output, source]) => {
    const content = readFileSync(sourcePath(source), "utf8");
    writeFileSync(join(options.output, output), content);
    return { path: output, source, sha256: sha256(content) };
  });
  writeCanonical(join(options.output, "inputs.json"), {
    proof_input_version: "0.1",
    claim_scope: "offline_conformance",
    evidence_label: "illustrative",
    generated_at: GENERATED_AT,
    run_id: RUN_ID,
    limits: { max_requests: 2, max_cost_usd: 0.05 },
    sources,
  });

  const records = loadRouteRecords(join(options.output, "input-route-ledger.jsonl"));
  const tasksValue = readJson(join(options.output, "input-replay-tasks.json")) as { tasks: ReplayArenaTask[] };
  const fixturesValue = readJson(join(options.output, "input-replay-fixtures.json")) as { fixtures: ReplayFixture[] };
  const protocol = readJson(join(options.output, "input-experiment-protocol.json"));
  const policy = readJson(join(options.output, "input-candidate-policy.json"));
  const gateConfig = readJson(join(options.output, "input-quality-gate.json")) as RouteGateConfig;
  const arena = await runReplayArena(records, {
    run_id: RUN_ID,
    generated_at: GENERATED_AT,
    tasks: tasksValue.tasks,
    limits: { max_requests: 2, max_cost_usd: 0.05 },
    executor: fixtureReplayExecutor(fixturesValue.fixtures),
  });
  writeFileSync(join(options.output, "replay.route.jsonl"), arena.records.map(canonicalJson).join("\n") + "\n");
  writeCanonical(join(options.output, "arena-report.json"), arena);

  const decision = decideReplayExperiment(arena.records, protocol, GENERATED_AT);
  const gate = evaluateRouteGate(records, records, gateConfig);
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
  writeCanonical(join(options.output, "experiment-decision.json"), decision);
  writeCanonical(join(options.output, "quality-gate.json"), gate);
  writeCanonical(join(options.output, "promotion.arpromote"), dossier);
  writeCanonical(join(options.output, "promotion-verification.json"), dossierVerification);
  writeCanonical(join(options.output, "evidence.arcap"), capsule);
  writeCanonical(join(options.output, "capsule-verification.json"), capsuleVerification);

  const states = [...foldRouteRecords(arena.records).values()];
  const exportProfile = (profile: TelemetryProfile): Record<string, unknown>[] => states.map((state) => routeToTelemetry(state, profile));
  writeCanonical(join(options.output, "otel-genai.json"), exportProfile("otel-genai"));
  writeCanonical(join(options.output, "openinference.json"), exportProfile("openinference"));
  writeFileSync(join(options.output, "index.html"), renderProofReport(decision, dossier, gate, capsule.manifest.root_sha256));

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
  let manifest: ProofManifest | undefined;
  try { manifest = readJson(join(path, "proof-manifest.json")) as ProofManifest; } catch (error) { return { valid: false, errors: [`proof manifest: ${(error as Error).message}`], artifact_count: 0 }; }
  if (manifest.proof_version !== "0.1" || manifest.claim_scope !== "offline_conformance" || manifest.evidence_label !== "illustrative") errors.push("proof manifest contract is invalid");
  if (!Array.isArray(manifest.artifacts) || !manifest.artifacts.length) errors.push("proof manifest artifacts are required");
  const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  const paths = artifacts.map((artifact) => artifact.path);
  if (new Set(paths).size !== paths.length) errors.push("proof manifest artifact paths must be unique");
  if (paths.some((entry) => !/^[a-z0-9][a-z0-9.-]*$/.test(entry))) errors.push("proof manifest artifact paths must be flat safe filenames");
  const body: Omit<ProofManifest, "root_sha256"> = { proof_version: manifest.proof_version, claim_scope: manifest.claim_scope, evidence_label: manifest.evidence_label, generated_at: manifest.generated_at, generator: manifest.generator, artifacts };
  if (manifest.root_sha256 !== manifestRoot(body)) errors.push("proof manifest root SHA-256 mismatch");
  const actualFiles = readdirSync(path).sort();
  const declaredFiles = [...paths, "proof-manifest.json"].sort();
  if (canonicalJson(actualFiles) !== canonicalJson(declaredFiles)) errors.push("proof pack files do not exactly match the manifest");
  for (const artifact of artifacts) {
    const artifactPath = join(path, artifact.path);
    if (!existsSync(artifactPath) || !statSync(artifactPath).isFile()) { errors.push(`missing artifact: ${artifact.path}`); continue; }
    if (artifact.sha256 !== sha256(readFileSync(artifactPath, "utf8"))) errors.push(`artifact SHA-256 mismatch: ${artifact.path}`);
  }
  let dossierVerdict: string | undefined;
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
  for (const telemetry of ["otel-genai.json", "openinference.json"]) {
    try {
      const value = readFileSync(join(path, telemetry), "utf8").toLowerCase();
      const forbidden = ["input.messages", "output.messages", "prompt", "response.content", "endpoint", "authorization", "extensions"];
      for (const marker of forbidden) if (value.includes(marker)) errors.push(`${telemetry} contains forbidden content marker: ${marker}`);
    } catch (error) { errors.push(`${telemetry}: ${(error as Error).message}`); }
  }
  try {
    if (!readFileSync(join(path, "index.html"), "utf8").includes("Illustrative offline conformance evidence")) errors.push("proof report is missing its evidence limitation");
  } catch (error) { errors.push(`proof report: ${(error as Error).message}`); }
  return { valid: errors.length === 0, errors, root_sha256: manifest.root_sha256, artifact_count: artifacts.length, ...(dossierVerdict ? { dossier_verdict: dossierVerdict } : {}) };
}
