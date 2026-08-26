import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "dist/cli.js");
const verifier = join(root, ".github/actions/agentroute-proof/verify.mjs");
const scratch = mkdtempSync(join(tmpdir(), "agentroute-proof-action-"));
let passed = 0;

function ok(name, condition) {
  if (!condition) throw new Error(`proof action check failed: ${name}`);
  passed++;
  console.log(`✓ ${name}`);
}

function runAction(name, inputs, succeeds) {
  const output = join(scratch, `${name}.output`);
  const result = spawnSync(process.execPath, [verifier], {
    cwd: scratch,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_WORKSPACE: scratch,
      GITHUB_OUTPUT: output,
      AGENTROUTE_PROOF_PACK: inputs.proofPack || "",
      AGENTROUTE_ATTESTATION: inputs.attestation || "",
      AGENTROUTE_PUBLIC_KEY: inputs.publicKey || "",
      AGENTROUTE_REQUIRE_TRUSTED_SIGNATURE: inputs.requireTrusted || "false",
    },
  });
  ok(name, succeeds ? result.status === 0 : result.status !== 0);
  if (!succeeds) ok(`${name} emits no successful outputs`, !existsSync(output) || readFileSync(output, "utf8") === "");
  return existsSync(output) ? readFileSync(output, "utf8") : "";
}

try {
  const proofName = "proof pack;touch action-pwned";
  const proofPath = join(scratch, proofName);
  execFileSync(process.execPath, [cli, "proof", "run", "--out", proofPath], { stdio: "pipe" });
  const keys = generateKeyPairSync("ed25519");
  const privateKey = join(scratch, "release private.pem");
  const publicKey = join(scratch, "release public.pem");
  const attestation = join(scratch, "proof pack.arsig");
  writeFileSync(privateKey, keys.privateKey.export({ type: "pkcs8", format: "pem" }));
  writeFileSync(publicKey, keys.publicKey.export({ type: "spki", format: "pem" }));
  execFileSync(process.execPath, [cli, "proof", "sign", proofPath, "--private-key", privateKey, "-o", attestation], { stdio: "pipe" });

  const unsigned = runAction("unsigned", { proofPack: proofName }, true);
  ok("unsigned verification emits the manifest root and false signature flags", /root-sha256=sha256:[0-9a-f]{64}/.test(unsigned) && unsigned.includes("artifact-count=31") && unsigned.includes("signature-valid=false") && unsigned.includes("signature-trusted=false"));
  const untrusted = runAction("untrusted", { proofPack: proofName, attestation: "proof pack.arsig" }, true);
  ok("embedded-key verification remains explicitly untrusted", untrusted.includes("signature-valid=true") && untrusted.includes("signature-trusted=false"));
  const trusted = runAction("trusted", { proofPack: proofName, attestation: "proof pack.arsig", publicKey: "release public.pem", requireTrusted: "true" }, true);
  ok("matching pinned key satisfies required trust", trusted.includes("signature-valid=true") && trusted.includes("signature-trusted=true"));

  runAction("invalid-boolean", { proofPack: proofName, requireTrusted: "yes" }, false);
  runAction("missing-trust-inputs", { proofPack: proofName, requireTrusted: "true" }, false);
  runAction("key-without-attestation", { proofPack: proofName, publicKey: "release public.pem" }, false);
  runAction("missing-proof", { proofPack: "does-not-exist" }, false);
  const wrongKey = join(scratch, "wrong public.pem");
  writeFileSync(wrongKey, generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }));
  runAction("wrong-key", { proofPack: proofName, attestation: "proof pack.arsig", publicKey: "wrong public.pem", requireTrusted: "true" }, false);

  const attestationText = readFileSync(attestation, "utf8");
  writeFileSync(attestation, "{}\n");
  runAction("altered-attestation", { proofPack: proofName, attestation: "proof pack.arsig" }, false);
  writeFileSync(attestation, attestationText);
  const experiment = join(proofPath, "experiment-decision.json");
  const experimentText = readFileSync(experiment, "utf8");
  writeFileSync(experiment, "{}\n");
  runAction("altered-proof", { proofPack: proofName }, false);
  writeFileSync(experiment, experimentText);

  ok("shell metacharacters in the proof path were treated as data", !existsSync(join(scratch, "action-pwned")));
  console.log(`AgentRoute proof action: ${passed} checks passed`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
