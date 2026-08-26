import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
if (pkg.name !== "agentroute-evidence") throw new Error("release package name must remain agentroute-evidence");
const cache = mkdtempSync(join(tmpdir(), "agentroute-npm-cache-"));
let output;
try {
  output = execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", cache], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: cache },
  });
const result = JSON.parse(output)[0];
if (!result || !Array.isArray(result.files)) throw new Error("npm pack did not return a package file manifest");
const files = result.files.map((entry) => entry.path).sort();
const required = [
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "dist/cli.js",
  "dist/drift.js",
  "dist/incident.js",
  "dist/index.d.ts",
  "dist/index.js",
  "dist/operations-review.js",
  "dist/proof-pack.js",
  "dist/reliability-timeline.js",
  "dist/scenario.js",
  "dist/slo.js",
  "docs/operations-intelligence-spec.md",
  "docs/launch-showcase-spec.md",
  "docs/public-proof-pack-spec.md",
  "docs/reliability-timeline-spec.md",
  "docs/slo-operations-review-spec.md",
  "examples/model-routing.route.jsonl",
  "examples/evidence-suite.replay-fixtures.json",
  "examples/connectors/sample-gateway-adapter.mjs",
  "examples/connectors/sample-gateway-event.json",
  "examples/public-proof.cases.json",
  "examples/public-proof.drift.json",
  "examples/public-proof.protocol.json",
  "examples/public-proof.scenario.json",
  "examples/public-proof.slo.json",
  "examples/operations-drift.json",
  "examples/provider-outage.scenario.json",
  "examples/routing-slo.json",
  "package.json",
  "route-conformance/check.mjs",
  "schema/routedecision-0.1.schema.json",
];
const missing = required.filter((path) => !files.includes(path));
if (missing.length) throw new Error(`package is missing required files: ${missing.join(", ")}`);
const forbidden = files.filter((path) =>
  path.startsWith("src/") ||
  path.startsWith("test/") ||
  path.startsWith(".github/") ||
  path.startsWith("local/") ||
  path.includes("node_modules/") ||
  /(?:^|\/)(?:\.env|.*\.pem|.*\.key|queue\.json)$/.test(path)
);
if (forbidden.length) throw new Error(`package contains forbidden files: ${forbidden.join(", ")}`);
const bin = pkg.bin?.ar;
if (typeof bin !== "string" || !files.includes(bin.replace(/^\.\//, ""))) throw new Error("package bin.ar does not reference a packed file");
const tarball = join(cache, result.filename);
const consumer = join(cache, "consumer");
mkdirSync(consumer);
execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], {
  cwd: consumer,
  stdio: "pipe",
  env: { ...process.env, npm_config_cache: join(cache, "install-cache") },
});
const help = execFileSync(join(consumer, "node_modules", ".bin", "ar"), ["--help"], { cwd: consumer, encoding: "utf8" });
if (!help.includes("AgentRoute") || !help.includes("ar drift") || !help.includes("ar incident") || !help.includes("ar slo") || !help.includes("ar ops") || !help.includes("ar history") || !help.includes("ar proof")) throw new Error("installed package CLI smoke test failed");
execFileSync(process.execPath, ["--input-type=module", "-e", "import('agentroute-evidence').then(m=>{if(typeof m.evaluateRoutingDrift!=='function'||typeof m.runRoutingScenario!=='function'||typeof m.analyzeRouteIncidents!=='function'||typeof m.evaluateRoutingSlo!=='function'||typeof m.createOperationsReview!=='function'||typeof m.createReliabilityTimeline!=='function'||typeof m.buildProofPack!=='function'||typeof m.verifyProofPack!=='function')process.exit(1)})"], { cwd: consumer, stdio: "pipe" });
const installedProof = join(consumer, "proof-pack");
const proofRun = JSON.parse(execFileSync(join(consumer, "node_modules", ".bin", "ar"), ["proof", "run", "--out", installedProof], { cwd: consumer, encoding: "utf8" }));
const proofVerify = JSON.parse(execFileSync(join(consumer, "node_modules", ".bin", "ar"), ["proof", "verify", installedProof], { cwd: consumer, encoding: "utf8" }));
if (proofRun.artifact_count !== 31 || !proofVerify.valid || proofVerify.dossier_verdict !== "eligible" || proofVerify.operations_status !== "attention" || proofVerify.timeline_status !== "attention") throw new Error("installed package proof-showcase verification failed");
console.log(`package install verified: ${result.filename} (${files.length} files, ${result.size} bytes)`);
} finally {
  rmSync(cache, { recursive: true, force: true });
}
