import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const cache = mkdtempSync(join(tmpdir(), "agentroute-npm-cache-"));
let output;
try {
  output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: cache },
  });
} finally {
  rmSync(cache, { recursive: true, force: true });
}
const result = JSON.parse(output)[0];
if (!result || !Array.isArray(result.files)) throw new Error("npm pack did not return a package file manifest");
const files = result.files.map((entry) => entry.path).sort();
const required = [
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "dist/cli.js",
  "dist/index.d.ts",
  "dist/index.js",
  "examples/model-routing.route.jsonl",
  "examples/evidence-suite.replay-fixtures.json",
  "examples/connectors/sample-gateway-adapter.mjs",
  "examples/connectors/sample-gateway-event.json",
  "examples/public-proof.cases.json",
  "examples/public-proof.protocol.json",
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
console.log(`package dry run verified: ${result.filename} (${files.length} files, ${result.size} bytes)`);
