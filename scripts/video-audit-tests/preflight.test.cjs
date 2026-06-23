#!/usr/bin/env node

const assert = require("node:assert/strict");

require("./register-ts.cjs");

const { buildPreflight } = require("../../src/lib/video-engine/preflight-eval.ts");

function baseFacts(overrides = {}) {
  return {
    sceneSplitProvider: "google",
    sceneSplitKey: true,
    labs69KeyCount: 1,
    ffmpeg: true,
    outputWritable: true,
    voiceConfigured: true,
    driveConnected: false,
    driveSyncEnabled: false,
    ...overrides,
  };
}

console.log("Test 1 - preflight gates missing selected scene-split provider key:");
{
  const google = buildPreflight(baseFacts({ sceneSplitProvider: "google", sceneSplitKey: false }));
  assert.equal(google.ready, false);
  assert.equal(google.checks.find((check) => check.id === "scene_split_key")?.detail.includes("GOOGLE_API_KEY"), true);

  const anthropic = buildPreflight(baseFacts({ sceneSplitProvider: "anthropic", sceneSplitKey: false }));
  assert.equal(anthropic.ready, false);
  assert.equal(anthropic.checks.find((check) => check.id === "scene_split_key")?.detail.includes("ANTHROPIC_API_KEY"), true);
  console.log("  ok");
}

console.log("Test 2 - preflight blocks missing media key before run creation:");
{
  const result = buildPreflight(baseFacts({ labs69KeyCount: 0 }));
  assert.equal(result.ready, false);
  assert.equal(result.checks.find((check) => check.id === "labs69_key")?.required, true);
  console.log("  ok");
}
