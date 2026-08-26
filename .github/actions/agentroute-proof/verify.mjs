import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SHA256 = /^sha256:[0-9a-f]{64}$/;

function fail(message) {
  console.error(`AgentRoute proof action: ${message}`);
  process.exit(1);
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) fail(`${name} is required`);
  return value;
}

function callerPath(value, workspace) {
  return isAbsolute(value) ? value : resolve(workspace, value);
}

const workspace = requiredEnvironment("GITHUB_WORKSPACE");
const outputPath = requiredEnvironment("GITHUB_OUTPUT");
const proofInput = requiredEnvironment("AGENTROUTE_PROOF_PACK");
const attestationInput = process.env.AGENTROUTE_ATTESTATION || "";
const publicKeyInput = process.env.AGENTROUTE_PUBLIC_KEY || "";
const requireTrustedInput = process.env.AGENTROUTE_REQUIRE_TRUSTED_SIGNATURE || "false";
if (requireTrustedInput !== "true" && requireTrustedInput !== "false") fail("require-trusted-signature must equal true or false");
const requireTrusted = requireTrustedInput === "true";
if (publicKeyInput && !attestationInput) fail("public-key requires attestation");
if (requireTrusted && (!attestationInput || !publicKeyInput)) fail("trusted signature verification requires both attestation and public-key");

const actionDirectory = dirname(fileURLToPath(import.meta.url));
const cli = resolve(actionDirectory, "../../..", "dist/cli.js");
const args = [cli, "proof", "verify", callerPath(proofInput, workspace)];
if (attestationInput) args.push("--attestation", callerPath(attestationInput, workspace));
if (publicKeyInput) args.push("--public-key", callerPath(publicKeyInput, workspace));
const command = spawnSync(process.execPath, args, { encoding: "utf8" });
if (command.stdout) process.stdout.write(command.stdout);
if (command.stderr) process.stderr.write(command.stderr);
if (command.error) fail(command.error.message);
if (command.status !== 0) process.exit(command.status || 1);

let verification;
try {
  verification = JSON.parse(command.stdout);
} catch (error) {
  fail(`CLI returned invalid JSON: ${error.message}`);
}
if (!verification || verification.valid !== true) fail("CLI did not return a valid proof verification");
if (typeof verification.root_sha256 !== "string" || !SHA256.test(verification.root_sha256)) fail("verification root SHA-256 is invalid");
if (!Number.isSafeInteger(verification.artifact_count) || verification.artifact_count < 1) fail("verification artifact count is invalid");
const signatureValid = verification.signature_valid === true;
const signatureTrusted = verification.signature_trusted === true;
if (requireTrusted && !signatureTrusted) fail("the detached proof signature is not trusted");

appendFileSync(outputPath, [
  `root-sha256=${verification.root_sha256}`,
  `artifact-count=${verification.artifact_count}`,
  `signature-valid=${signatureValid}`,
  `signature-trusted=${signatureTrusted}`,
  "",
].join("\n"));
