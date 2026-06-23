#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const pipelinePath = path.join(process.cwd(), "src/lib/video-engine/pipeline.ts");
const reassemblePath = path.join(process.cwd(), "src/app/api/video/runs/[id]/reassemble/route.ts");
const pagePath = path.join(process.cwd(), "src/app/studio/video/page.tsx");

const pipeline = fs.readFileSync(pipelinePath, "utf-8");
const reassembleRoute = fs.readFileSync(reassemblePath, "utf-8");
const page = fs.readFileSync(pagePath, "utf-8");

function sourceBetween(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  assert.notEqual(start, -1, `Missing ${startNeedle}`);
  const end = source.indexOf(endNeedle, start);
  assert.notEqual(end, -1, `Missing ${endNeedle} after ${startNeedle}`);
  return source.slice(start, end);
}

console.log("Test 1 - active pipeline dispatch only runs Hybrid and Image cut:");
{
  const dispatch = sourceBetween(pipeline, "export async function runPipeline", "export async function resumeRun");
  assert.match(dispatch, /runMode === "image"/);
  assert.match(dispatch, /runMode === "hybrid"/);
  assert.match(dispatch, /retiredVideoModeError\(runMode\)/);
  assert.doesNotMatch(dispatch, /runMode === "full"/);
  assert.doesNotMatch(dispatch, /runMode === "stock"/);
  console.log("  ok");
}

console.log("Test 2 - resume rejects retired modes instead of regenerating them:");
{
  const resume = sourceBetween(pipeline, "export async function resumeRun", "export async function runHybridPipeline");
  assert.match(resume, /mode === "image"/);
  assert.match(resume, /mode === "hybrid"/);
  assert.match(resume, /retiredVideoModeError\(mode\)/);
  assert.doesNotMatch(resume, /mode === "full"/);
  assert.doesNotMatch(resume, /mode === "stock"/);
  assert.doesNotMatch(resume, /finishRunContinuous/);
  console.log("  ok");
}

console.log("Test 3 - Hybrid implementation has no Full or Stock mode branch:");
{
  const hybrid = sourceBetween(pipeline, "export async function runHybridPipeline", "const IMAGE_CUT_CARD_SECONDS");
  assert.match(hybrid, /const mode = "hybrid"/);
  assert.match(hybrid, /splitHybridScript\(runId, script, freshMinutes \* 60/);
  assert.doesNotMatch(hybrid, /mode === "full"/);
  assert.doesNotMatch(hybrid, /mode === "stock"/);
  assert.doesNotMatch(hybrid, /splitScript\(runId, script/);
  console.log("  ok");
}

console.log("Test 4 - reassemble route rejects retired modes before resume preflight:");
{
  assert.match(reassembleRoute, /readRunMode\(id\)/);
  assert.match(reassembleRoute, /mode !== "hybrid" && mode !== "image"/);
  assert.match(reassembleRoute, /errorKind: "mode_retired"/);
  const retiredIndex = reassembleRoute.indexOf('errorKind: "mode_retired"');
  const canResumeIndex = reassembleRoute.indexOf("canResumeRun(id)");
  assert.ok(retiredIndex >= 0, "retired mode rejection is missing");
  assert.ok(canResumeIndex > retiredIndex, "resume checks should not run before retired-mode rejection");
  console.log("  ok");
}

console.log("Test 5 - retired history rows are read-only in the detail UI:");
{
  const detail = sourceBetween(page, "function VideoRunDetailPage", "function VideoRunLoadingState");
  assert.match(detail, /const executableMode = mode === "hybrid" \|\| mode === "image"/);
  assert.match(detail, /const canResume = executableMode &&/);
  console.log("  ok");
}
