import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function fail(message) {
  console.error(`AgentRoute gate action: ${message}`);
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
const current = callerPath(requiredEnvironment("AGENTROUTE_CURRENT"), workspace);
const baseline = callerPath(requiredEnvironment("AGENTROUTE_BASELINE"), workspace);
const config = callerPath(requiredEnvironment("AGENTROUTE_CONFIG"), workspace);
const actionDirectory = dirname(fileURLToPath(import.meta.url));
const cli = resolve(actionDirectory, "../../..", "dist/cli.js");
const command = spawnSync(process.execPath, [cli, "gate", current, "--baseline", baseline, "--config", config, "--format", "github"], { encoding: "utf8" });
if (command.stdout) process.stdout.write(command.stdout);
if (command.stderr) process.stderr.write(command.stderr);
if (command.error) fail(command.error.message);
if (command.status !== 0) process.exit(command.status || 1);
