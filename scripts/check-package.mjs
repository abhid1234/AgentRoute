import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

function requireContract(condition, message) {
  if (!condition) throw new Error(`release workflow contract failed: ${message}`);
}

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
if (pkg.name !== "@avee1234/agentroute") throw new Error("release package name must remain @avee1234/agentroute");
const workflow = parseYaml(readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"));
const buildJob = workflow?.jobs?.build;
const publishJob = workflow?.jobs?.["publish-npm"];
const packStep = buildJob?.steps?.find((step) => step.id === "pack");
const provenanceStep = buildJob?.steps?.find((step) => step.uses?.startsWith("actions/attest-build-provenance@"));
const sbomStep = buildJob?.steps?.find((step) => step.uses?.startsWith("actions/attest-sbom@"));
const uploadStep = buildJob?.steps?.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
const downloadStep = publishJob?.steps?.find((step) => step.uses?.startsWith("actions/download-artifact@"));
const registryStep = publishJob?.steps?.find((step) => step.id === "registry");
const publishStep = publishJob?.steps?.find((step) => step.name === "Publish exact version");
const tarballStepOutput = "${{ steps.pack.outputs.tarball }}";
const tarballJobOutput = "${{ needs.build.outputs.tarball }}";
const integrityStepOutput = "${{ steps.pack.outputs.integrity }}";
const integrityJobOutput = "${{ needs.build.outputs.integrity }}";
requireContract(buildJob?.outputs?.tarball === tarballStepOutput, "build job must export the pack step tarball");
requireContract(buildJob?.outputs?.integrity === integrityStepOutput, "build job must export the pack step integrity");
requireContract(packStep?.run?.includes('echo "tarball=$TARBALL" >> "$GITHUB_OUTPUT"'), "pack step must write its tarball output");
requireContract(packStep?.run?.includes('echo "integrity=$INTEGRITY" >> "$GITHUB_OUTPUT"'), "pack step must write its integrity output");
requireContract(provenanceStep?.with?.["subject-path"] === tarballStepOutput, "provenance must attest the packed tarball");
requireContract(sbomStep?.with?.["subject-path"] === tarballStepOutput, "SBOM must attest the packed tarball");
requireContract(uploadStep?.with?.path?.split("\n").includes(tarballStepOutput), "artifact must contain the packed tarball");
requireContract(uploadStep?.with?.name === downloadStep?.with?.name, "artifact upload and download names must match");
requireContract(publishJob?.needs === "build", "publish job must depend on build");
requireContract(registryStep?.env?.EXPECTED_INTEGRITY === integrityJobOutput, "registry check must receive the reviewed tarball integrity");
requireContract(registryStep?.run === "node scripts/check-registry-version.mjs", "registry check must use the tested release guard");
requireContract(publishStep?.env?.TARBALL === tarballJobOutput, "publish step must receive the build tarball output");
requireContract(publishStep?.run?.includes('npm publish "$TARBALL"'), "publish step must publish the exact handed-off tarball");
requireContract(publishStep?.run?.includes("--access public --provenance"), "publish step must retain public access and provenance");
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
if (!/^avee1234-agentroute-\d+\.\d+\.\d+\.tgz$/.test(result.filename)) throw new Error(`unexpected scoped package tarball name: ${result.filename}`);
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
  "dist/proof-attestation.js",
  "dist/proof-pack.js",
  "dist/reliability-timeline.js",
  "dist/scenario.js",
  "dist/slo.js",
  "docs/operations-intelligence-spec.md",
  "docs/launch-showcase-spec.md",
  "docs/public-proof-pack-spec.md",
  "docs/proof-attestation-spec.md",
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
execFileSync(process.execPath, ["--input-type=module", "-e", "import('@avee1234/agentroute').then(m=>{if(typeof m.evaluateRoutingDrift!=='function'||typeof m.runRoutingScenario!=='function'||typeof m.analyzeRouteIncidents!=='function'||typeof m.evaluateRoutingSlo!=='function'||typeof m.createOperationsReview!=='function'||typeof m.createReliabilityTimeline!=='function'||typeof m.buildProofPack!=='function'||typeof m.verifyProofPack!=='function'||typeof m.compareProofPacks!=='function'||typeof m.formatGitHubProofDiff!=='function'||typeof m.signProofPack!=='function'||typeof m.verifyProofAttestation!=='function')process.exit(1)})"], { cwd: consumer, stdio: "pipe" });
const installedProof = join(consumer, "proof-pack");
const proofRun = JSON.parse(execFileSync(join(consumer, "node_modules", ".bin", "ar"), ["proof", "run", "--out", installedProof], { cwd: consumer, encoding: "utf8" }));
const proofVerify = JSON.parse(execFileSync(join(consumer, "node_modules", ".bin", "ar"), ["proof", "verify", installedProof], { cwd: consumer, encoding: "utf8" }));
if (proofRun.artifact_count !== 31 || !proofVerify.valid || proofVerify.dossier_verdict !== "eligible" || proofVerify.operations_status !== "attention" || proofVerify.timeline_status !== "attention") throw new Error("installed package proof-showcase verification failed");
const proofKeys = generateKeyPairSync("ed25519");
const proofPrivateKeyPath = join(consumer, "proof-private.pem");
const proofPublicKeyPath = join(consumer, "proof-public.pem");
const proofAttestationPath = join(consumer, "proof-pack.arsig");
writeFileSync(proofPrivateKeyPath, proofKeys.privateKey.export({ type: "pkcs8", format: "pem" }));
writeFileSync(proofPublicKeyPath, proofKeys.publicKey.export({ type: "spki", format: "pem" }));
execFileSync(join(consumer, "node_modules", ".bin", "ar"), ["proof", "sign", installedProof, "--private-key", proofPrivateKeyPath, "-o", proofAttestationPath], { cwd: consumer, stdio: "pipe" });
const trustedProof = JSON.parse(execFileSync(join(consumer, "node_modules", ".bin", "ar"), ["proof", "verify", installedProof, "--attestation", proofAttestationPath, "--public-key", proofPublicKeyPath], { cwd: consumer, encoding: "utf8" }));
if (!trustedProof.valid || !trustedProof.signature_valid || !trustedProof.signature_trusted) throw new Error("installed package proof-attestation verification failed");
console.log(`package install verified: ${result.filename} (${files.length} files, ${result.size} bytes)`);
} finally {
  rmSync(cache, { recursive: true, force: true });
}
