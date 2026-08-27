import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyRegistryLookup, main } from "./check-registry-version.mjs";

const integrity = "sha512-reviewed";

assert.equal(classifyRegistryLookup({ status: 0, stdout: JSON.stringify(integrity) }, integrity), true);
assert.equal(classifyRegistryLookup({ status: 1, stderr: "npm error code E404" }, integrity), false);
assert.throws(
  () => classifyRegistryLookup({ status: 0, stdout: JSON.stringify("sha512-other") }, integrity),
  /does not match/,
);
assert.throws(
  () => classifyRegistryLookup({ status: 1, stderr: "npm error code EAI_AGAIN" }, integrity),
  /without an explicit E404/,
);
assert.throws(
  () => classifyRegistryLookup({ status: 0, stdout: "not-json" }, integrity),
  /malformed integrity JSON/,
);
assert.throws(
  () => classifyRegistryLookup({ status: 0, stdout: JSON.stringify("") }, integrity),
  /invalid integrity value/,
);
assert.throws(
  () => classifyRegistryLookup({ status: 0, stdout: JSON.stringify(null) }, integrity),
  /invalid integrity value/,
);
assert.throws(() => main({}), /are required/);

const fixture = mkdtempSync(join(tmpdir(), "agentroute-registry-guard-"));
try {
  const packageFile = join(fixture, "package.json");
  const output = join(fixture, "github-output");
  writeFileSync(packageFile, JSON.stringify({ name: "@avee1234/agentroute" }));
  const calls = [];
  const lookup = (...args) => {
    calls.push(args);
    return { status: 0, stdout: JSON.stringify(integrity), stderr: "" };
  };
  main(
    { EXPECTED_INTEGRITY: integrity, GITHUB_OUTPUT: output, REQUESTED_VERSION: "0.2.1" },
    lookup,
    packageFile,
  );
  assert.deepEqual(calls[0].slice(0, 2), [
    "npm",
    ["view", "@avee1234/agentroute@0.2.1", "dist.integrity", "--json"],
  ]);
  assert.equal(readFileSync(output, "utf8"), "published=true\n");

  const absentOutput = join(fixture, "github-output-absent");
  main(
    { EXPECTED_INTEGRITY: integrity, GITHUB_OUTPUT: absentOutput, REQUESTED_VERSION: "0.2.2" },
    () => ({ status: 1, stdout: "", stderr: "npm error code E404" }),
    packageFile,
  );
  assert.equal(readFileSync(absentOutput, "utf8"), "published=false\n");

  writeFileSync(packageFile, JSON.stringify({ name: "" }));
  assert.throws(
    () => main({ EXPECTED_INTEGRITY: integrity, GITHUB_OUTPUT: output, REQUESTED_VERSION: "0.2.1" }, lookup, packageFile),
    /package.json name is required/,
  );
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

console.log("release registry guard: 12 checks passed");
