#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const testDir = __dirname;
const repoRoot = path.resolve(testDir, "../..");
const tests = fs
  .readdirSync(testDir)
  .filter((file) => file.endsWith(".test.cjs"))
  .sort();

for (const test of tests) {
  console.log(`\n▶ ${test}`);
  const result = spawnSync(process.execPath, [path.join(testDir, test)], {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log("\nAll video audit tests passed.");
