#!/usr/bin/env node
// Standalone AgentRoute CLI. The historical integration exposed this as `ot route`;
// this repository keeps the route subcommand so existing invocations remain clear.
import { runRouteCli } from "./route-cli.js";

try {
  const args = process.argv.slice(2);
  if (args[0] === "route") args.shift();
  await runRouteCli(args);
} catch (error) {
  console.error(String((error as Error).message));
  process.exit(1);
}
