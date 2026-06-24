#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const assemblePath = path.join(process.cwd(), "src/lib/video-engine/services/video-assemble.ts");
const source = fs.readFileSync(assemblePath, "utf-8");

function sourceBetween(start, end) {
  const startIndex = source.indexOf(start);
  assert.ok(startIndex >= 0, `${start} is missing`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(endIndex > startIndex, `${end} is missing after ${start}`);
  return source.slice(startIndex, endIndex);
}

console.log("Test 1 - Hybrid per-scene voiceover does not use -shortest:");
{
  const body = sourceBetween("async function renderSceneAV", "export interface PerSceneAssemblyResult");
  assert.match(body, /"-map", "1:a:0"/);
  assert.match(body, /`-t \$\{audioDur\.toFixed\(3\)\}`/);
  assert.doesNotMatch(body, /"-shortest"/);
  console.log("  ok");
}

console.log("Test 2 - continuous voiceover muxers trim with -t instead of -shortest:");
{
  const imageCutMux = sourceBetween("function muxAudioNoFades", "function wordCount");
  const tailMux = sourceBetween("const muxCmd = ffmpeg()", "await saveRegisteredFfmpeg(runId, \"tail audio mux\"");
  assert.match(imageCutMux, /"-map 1:a:0"/);
  assert.match(imageCutMux, /`-t \$\{\(audioDur \+ audioLeadSec\)\.toFixed\(3\)\}`/);
  assert.doesNotMatch(imageCutMux, /"-shortest"/);
  assert.match(tailMux, /"-map", "1:a:0"/);
  assert.match(tailMux, /`-t \$\{audioDur\.toFixed\(3\)\}`/);
  assert.doesNotMatch(tailMux, /"-shortest"/);
  console.log("  ok");
}
