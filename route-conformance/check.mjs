#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRouteRecords } from "../dist/route.js";

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8"));
let passed = 0;
let failed = 0;

for (const path of manifest.valid) {
  try {
    const records = parseRouteRecords(readFileSync(join(here, path), "utf8"), path);
    if (!records.length) throw new Error("no records");
    console.log(`✓ valid ${path} (${records.length} record${records.length === 1 ? "" : "s"})`);
    passed++;
  } catch (error) {
    console.error(`✗ valid ${path}: ${error.message}`);
    failed++;
  }
}

for (const fixture of manifest.invalid) {
  try {
    parseRouteRecords(readFileSync(join(here, fixture.path), "utf8"), fixture.path);
    console.error(`✗ invalid ${fixture.path}: unexpectedly accepted`);
    failed++;
  } catch (error) {
    if (!error.message.includes(fixture.error)) {
      console.error(`✗ invalid ${fixture.path}: expected ${JSON.stringify(fixture.error)}, got ${JSON.stringify(error.message)}`);
      failed++;
    } else {
      console.log(`✓ invalid ${fixture.path} rejected (${fixture.error})`);
      passed++;
    }
  }
}

console.log(`\nAgentRoute conformance: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
