#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const pipelinePath = path.join(process.cwd(), "src/lib/video-engine/pipeline.ts");
const assemblePath = path.join(process.cwd(), "src/lib/video-engine/services/video-assemble.ts");
const pipeline = fs.readFileSync(pipelinePath, "utf-8");
const assemble = fs.readFileSync(assemblePath, "utf-8");

function sourceBetween(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  assert.notEqual(start, -1, `Missing ${startNeedle}`);
  const end = source.indexOf(endNeedle, start);
  assert.notEqual(end, -1, `Missing ${endNeedle} after ${startNeedle}`);
  return source.slice(start, end);
}

console.log("Test 1 - Image cut plans a fresh intro plus deterministic 20s image cards:");
{
  assert.match(pipeline, /const IMAGE_CUT_CARD_SECONDS = 20/);
  assert.match(pipeline, /const IMAGE_CUT_CARD_TARGET_WORDS = Math\.round\(\(IMAGE_CUT_CARD_SECONDS \/ 60\) \* WORDS_PER_MINUTE\)/);
  assert.match(pipeline, /const IMAGE_CUT_CARD_CHUNK_TARGET_WORDS = Math\.round\(\(\(IMAGE_CUT_CARD_SECONDS \+ 4\) \/ 60\) \* WORDS_PER_MINUTE\)/);
  assert.match(pipeline, /const IMAGE_CUT_CARD_MAX_WORDS = Math\.round\(\(\(IMAGE_CUT_CARD_SECONDS \+ 10\) \/ 60\) \* WORDS_PER_MINUTE\)/);
  const planner = sourceBetween(pipeline, "async function planImageCutScenes", "function buildImageCutCardScenes");
  assert.match(planner, /splitFreshOpeningScript\(/);
  assert.match(planner, /buildImageCutCardScenes\(/);
  assert.doesNotMatch(planner, /splitScript\(/, "Image cut planner must not full-script scene-split long scripts.");
  assert.match(planner, /Image Cut plan ready:.*generated image card/s);
  console.log("  ok");
}

console.log("Test 2 - Image cut card scenes are generated tail scenes with 20s duration hints:");
{
  const cards = sourceBetween(pipeline, "function buildImageCutCardScenes", "function reusableImageCutPlan");
  assert.match(cards, /chunkTextByNarrationUnits\(tailText/);
  assert.match(cards, /targetWords: IMAGE_CUT_CARD_CHUNK_TARGET_WORDS/);
  assert.match(cards, /maxWords: IMAGE_CUT_CARD_MAX_WORDS/);
  assert.match(cards, /duration_hint_sec: IMAGE_CUT_CARD_SECONDS/);
  assert.match(cards, /source_kind: "image_card"/);
  assert.match(cards, /fallbackImageCutPrompt\(scene/);
  console.log("  ok");
}

console.log("Test 3 - long Image cut runs skip the expensive Visual Director pass:");
{
  assert.match(pipeline, /const IMAGE_CUT_VISUAL_DIRECTOR_MAX_SCENES = 120/);
  const runImage = sourceBetween(pipeline, "export async function runImagePipeline", "/** Whether a run can be resumed");
  assert.match(runImage, /scenes\.length > IMAGE_CUT_VISUAL_DIRECTOR_MAX_SCENES/);
  assert.match(runImage, /skipping Visual Director/);
  assert.match(runImage, /planningMode: "fresh_intro_plus_20s_image_cards"/);
  console.log("  ok");
}

console.log("Test 4 - Image cut assembly uses scene duration hints instead of word-count-only timing:");
{
  const assembly = sourceBetween(assemble, "export async function assembleImageCut", "async function renderImageCutVideoClip");
  assert.match(assembly, /const durationWeights = ordered\.map/);
  assert.match(assembly, /v\.scene\.duration_hint_sec/);
  assert.match(assembly, /durationWeights\[i\] \/ totalDurationWeight/);
  assert.doesNotMatch(assembly, /words\[i\] \/ totalWords/);
  console.log("  ok");
}
