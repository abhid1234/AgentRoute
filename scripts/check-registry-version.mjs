import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function classifyRegistryLookup({ status, stdout = "", stderr = "" }, expectedIntegrity) {
  if (status === 0) {
    let registryIntegrity;
    try {
      registryIntegrity = JSON.parse(stdout);
    } catch {
      throw new Error("npm registry returned malformed integrity JSON");
    }
    if (typeof registryIntegrity !== "string" || registryIntegrity.length === 0) {
      throw new Error("npm registry returned an invalid integrity value");
    }
    if (registryIntegrity !== expectedIntegrity) {
      throw new Error("registry tarball integrity does not match the reviewed artifact");
    }
    return true;
  }

  if (`${stdout}\n${stderr}`.includes("E404")) return false;
  throw new Error(`npm registry lookup failed without an explicit E404 (exit ${status ?? "unknown"})`);
}

export function main(env = process.env, lookup = spawnSync, packageFile = "package.json") {
  const { EXPECTED_INTEGRITY, GITHUB_OUTPUT, REQUESTED_VERSION } = env;
  if (!EXPECTED_INTEGRITY || !GITHUB_OUTPUT || !REQUESTED_VERSION) {
    throw new Error("EXPECTED_INTEGRITY, GITHUB_OUTPUT, and REQUESTED_VERSION are required");
  }

  const packageName = JSON.parse(readFileSync(packageFile, "utf8")).name;
  if (typeof packageName !== "string" || packageName.length === 0) throw new Error("package.json name is required");
  const result = lookup("npm", ["view", `${packageName}@${REQUESTED_VERSION}`, "dist.integrity", "--json"], {
    encoding: "utf8",
  });
  const published = classifyRegistryLookup(result, EXPECTED_INTEGRITY);
  appendFileSync(GITHUB_OUTPUT, `published=${published}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
