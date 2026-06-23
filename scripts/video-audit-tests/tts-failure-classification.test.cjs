#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const pipelinePath = path.join(process.cwd(), "src/lib/video-engine/pipeline.ts");
const source = fs.readFileSync(pipelinePath, "utf-8");

console.log("Test 1 - fresh scene TTS failures stay classified as audio failures:");
{
  assert.match(source, /void audioPromise\.catch/);
  assert.match(source, /audio failed after fresh video succeeded/);
  assert.match(source, /fresh audio failed/);
  assert.match(source, /if \(msg\.startsWith\("fresh audio failed:"\)\) throw e/);
  assert.match(source, /video failed .* using still-motion fallback/);
  assert.equal(source.includes("fresh video failed after provider attempts"), false);

  const audioFailureIndex = source.indexOf("audio failed after fresh video succeeded");
  const videoFailureIndex = source.indexOf("video failed");
  assert.ok(audioFailureIndex >= 0, "audio failure log is missing");
  assert.ok(videoFailureIndex > audioFailureIndex, "video failure catch should be after the audio-specific catch");
  console.log("  ok");
}
