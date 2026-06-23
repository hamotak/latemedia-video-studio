#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(
  path.resolve(__dirname, "../../src/lib/video-engine/services/atmosphere.ts"),
  "utf-8"
);

console.log("Test 1 - short-only atmosphere skips normal 3 minute validation runs:");
{
  assert.match(source, /SHORT_VIDEO_ATMOSPHERE_LIMIT_SEC\s*=\s*3\s*\*\s*60/);
  assert.match(source, /durationSec\s*>?=\s*SHORT_VIDEO_ATMOSPHERE_LIMIT_SEC/);
  assert.match(source, /Atmosphere pass skipped for video >= 3 min/);
  console.log("  ok");
}
