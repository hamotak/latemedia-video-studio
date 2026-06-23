#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const routePath = path.join(process.cwd(), "src/app/api/video/runs/route.ts");
const source = fs.readFileSync(routePath, "utf-8");

console.log("Test 1 - run creation hydrates settings best-effort and gates preflight before insert/start:");
{
  assert.match(source, /Promise\.allSettled/);
  assert.match(source, /runPreflight/);
  assert.match(source, /preflight_failed/);
  assert.match(source, /voiceValidationError/);
  assert.match(source, /voice_invalid/);
  const hydrateIndex = source.indexOf('await hydrateRuntimeConfig("video-run-start")');
  const preflightIndex = source.indexOf("const preflight = runPreflight");
  const voiceValidationIndex = source.indexOf("const invalidVoice = await voiceValidationError");
  const insertIndex = source.indexOf("insertRun.run");
  const startIndex = source.indexOf("startRunPipeline(id, script)");
  assert.ok(hydrateIndex >= 0, "runtime config hydration should run before init/preflight");
  assert.ok(preflightIndex > hydrateIndex, "preflight should run after runtime config hydration");
  assert.ok(voiceValidationIndex > preflightIndex, "voice validation should run after required preflight passes");
  assert.ok(insertIndex > voiceValidationIndex, "run row should not be inserted before voice validation");
  assert.ok(startIndex > insertIndex, "worker should start only after run row creation");
  console.log("  ok");
}

console.log("Test 2 - run creation only accepts Hybrid and Image cut modes:");
{
  assert.match(source, /body\.mode === "hybrid" \|\| body\.mode === "image"/);
  assert.match(source, /Unsupported video mode\. Use Hybrid or Image cut\./);
  assert.match(source, /body\.mode == null \|\| body\.mode === ""\s+\?\s+"hybrid"/);
  assert.match(source, /config\.mode = mode/);
  assert.doesNotMatch(source, /body\.mode === "full"/);
  assert.doesNotMatch(source, /body\.mode === "stock"/);
  console.log("  ok");
}
