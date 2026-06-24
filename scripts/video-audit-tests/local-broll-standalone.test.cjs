#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function read(rel) {
  return fs.readFileSync(path.join(process.cwd(), rel), "utf-8");
}

const stockLibrary = read("src/lib/video-engine/services/stock-library.ts");
const stockGenerateRoute = read("src/app/api/video/stock/generate/route.ts");
const stockShared = read("src/app/api/video/stock/generate/_shared.ts");
const stockGen = read("src/lib/video-engine/services/stock-gen.ts");
const clipsPage = read("src/app/studio/video/clips/page.tsx");
const videoPage = read("src/app/studio/video/page.tsx");
const activeStockGen = stockGen.split("/* Legacy body")[0];

console.log("Test 1 - Hybrid stock cache uses Desktop B-roll IDs first:");
{
  assert.match(stockLibrary, /listBRollClipRows/);
  assert.match(stockLibrary, /resolveBRollClipPath/);
  assert.match(stockLibrary, /listBRollClipRows\(options\.channelName\)/);
  assert.match(stockLibrary, /const localPath = resolveBRollClipPath\(clip\.driveFileId\)/);
  assert.match(stockLibrary, /local B-roll/);
  console.log("  ok");
}

console.log("Test 2 - B-roll generation starts without Google Drive preflight:");
{
  assert.doesNotMatch(stockGenerateRoute, /getConnectionStatus/);
  assert.doesNotMatch(stockGenerateRoute, /drive_required/);
  assert.match(stockGenerateRoute, /LABS69_API_KEY/);
  assert.match(stockGenerateRoute, /GOOGLE_API_KEY/);
  console.log("  ok");
}

console.log("Test 3 - generated and retried B-rolls save locally:");
{
  assert.match(activeStockGen, /saveBRollClip/);
  assert.doesNotMatch(activeStockGen, /resolveDriveStockFolder/);
  assert.doesNotMatch(activeStockGen, /Drive folder check/);
  assert.doesNotMatch(activeStockGen, /await uploadFile/);
  assert.match(activeStockGen, /step\.driveFileLink = null/);
  console.log("  ok");
}

console.log("Test 4 - local clip links are not converted to fake Drive links:");
{
  assert.match(stockShared, /clip\.driveFileLink !== undefined/);
  assert.doesNotMatch(stockShared, /driveFileLink\(clip\.driveFileId\)/);
  console.log("  ok");
}

console.log("Test 5 - standalone UI avoids Drive-required B-roll copy:");
{
  assert.doesNotMatch(clipsPage, /Drive B-rolls/);
  assert.doesNotMatch(clipsPage, /Checking Drive/);
  assert.doesNotMatch(clipsPage, /Google Drive trash/);
  assert.doesNotMatch(clipsPage, /Open in Drive/);
  assert.doesNotMatch(videoPage, /Drive B-roll tail/);
  console.log("  ok");
}
