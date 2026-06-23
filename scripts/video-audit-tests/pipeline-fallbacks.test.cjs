#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const pipelinePath = path.join(process.cwd(), "src/lib/video-engine/pipeline.ts");
const source = fs.readFileSync(pipelinePath, "utf-8");

console.log("Test 1 - fresh fallback evidence and resume-compatible manifests exist:");
{
  assert.match(source, /interface FreshFallbackRecord/);
  assert.match(source, /fresh-fallbacks\.json/);
  assert.match(source, /function writeFreshFallback/);
  assert.match(source, /sourceMode === "still-motion-fallback"/);
  assert.match(source, /sourceMode === "stock-fallback"/);
  assert.match(source, /writeGeneratedVideoManifest\(vPath, \{\s*sourceMode: "stock-fallback"/s);
  assert.match(source, /writeGeneratedVideoManifest\(vPath, \{\s*sourceMode: "still-motion-fallback"/s);
  console.log("  ok");
}

console.log("Test 2 - image failures can use stock and video failures can use still-motion:");
{
  assert.match(source, /pickStockPath\?: \(\(\) => Promise<string \| null>\) \| null/);
  assert.match(source, /const stockSrc = opts\.pickStockPath \? await opts\.pickStockPath\(\) : null/);
  assert.match(source, /fs\.copyFileSync\(stockSrc, vPath\)/);
  assert.match(source, /kind: "stock-fallback"/);
  assert.match(source, /await renderStillMotionClip\(/);
  assert.match(source, /kind: "still-motion-fallback"/);
  assert.match(source, /enforceFailureThreshold\(runId, freshScenes\.length, freshItems\.length\)/);
  assert.equal(source.includes("freshItems.length < freshScenes.length"), false);
  console.log("  ok");
}

console.log("Test 3 - hybrid fresh scenes have a fallback stock picker and Drive metadata preserves fallback type:");
{
  assert.match(source, /const pickFreshFallbackStockPath = async \(\): Promise<string \| null> =>/);
  assert.match(source, /createShuffledStockDeckPicker\(cached, `\$\{runId\}:fresh-fallback`\)/);
  assert.match(source, /pickStockPath: pickFreshFallbackStockPath/);
  assert.match(source, /fallbackKind =\s*it\.kind === "still-motion-fallback"/s);
  assert.match(source, /it\.kind === "stock-fallback"/);
  assert.match(source, /sourceMode:\s*fallbackKind === "still-motion"/s);
  console.log("  ok");
}
