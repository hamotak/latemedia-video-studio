#!/usr/bin/env node

const assert = require("node:assert/strict");

require("./register-ts.cjs");

const { hybridSceneAVVideoFilter } = require("../../src/lib/video-engine/video-quality.ts");

console.log("Test 1 - hybrid fresh filter can slow short provider clips without frame hold:");
{
  const filter = hybridSceneAVVideoFilter(1920, 1080, null, {
    stretchFactor: 1.12,
    fps: 30,
    padSec: 0,
  });
  assert.match(filter, /setpts=1\.120\*\(PTS-STARTPTS\)/);
  assert.match(filter, /fps=30/);
  assert.doesNotMatch(filter, /tpad=stop_mode=clone/);
  console.log("  ok");
}

console.log("Test 2 - hybrid fresh filter still pads only after safe stretch is exhausted:");
{
  const filter = hybridSceneAVVideoFilter(1920, 1080, null, {
    stretchFactor: 1.15,
    fps: 30,
    padSec: 0.75,
  });
  assert.match(filter, /setpts=1\.150\*\(PTS-STARTPTS\)/);
  assert.match(filter, /tpad=stop_mode=clone:stop_duration=0\.750/);
  console.log("  ok");
}
