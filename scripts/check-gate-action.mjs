import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const runner = join(root, ".github/actions/agentroute-gate/run.mjs");
const scratch = mkdtempSync(join(tmpdir(), "agentroute-gate-action-"));
let passed = 0;

function ok(name, condition) {
  if (!condition) throw new Error(`gate action check failed: ${name}`);
  passed++;
  console.log(`✓ ${name}`);
}

function runAction(inputs) {
  return spawnSync(process.execPath, [runner], {
    cwd: scratch,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_WORKSPACE: scratch,
      AGENTROUTE_CURRENT: inputs.current || "",
      AGENTROUTE_BASELINE: inputs.baseline || "",
      AGENTROUTE_CONFIG: inputs.config || "",
    },
  });
}

try {
  const hostileName = "current\";touch action-pwned;#.route.jsonl";
  writeFileSync(join(scratch, hostileName), readFileSync(join(root, "examples/model-routing.route.jsonl"), "utf8"));
  writeFileSync(join(scratch, "baseline.route.jsonl"), readFileSync(join(root, "examples/model-routing.route.jsonl"), "utf8"));
  writeFileSync(join(scratch, "gate.json"), readFileSync(join(root, "examples/evidence-suite.gate.json"), "utf8"));
  const result = runAction({ current: hostileName, baseline: "baseline.route.jsonl", config: "gate.json" });
  ok("relative caller paths are evaluated from GITHUB_WORKSPACE", result.status === 0 && result.stdout.includes("::notice"));
  ok("shell metacharacters in gate inputs are treated as data", !existsSync(join(scratch, "action-pwned")));
  ok("missing gate inputs fail closed", runAction({ current: hostileName, baseline: "", config: "gate.json" }).status !== 0);
  console.log(`AgentRoute gate action: ${passed} checks passed`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
