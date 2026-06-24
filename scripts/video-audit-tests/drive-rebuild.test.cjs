#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

require("./register-ts.cjs");

const {
  countRawClipsOnDisk,
  readSceneVideoMetadata,
  rebuildSceneAssetsFromDisk,
  shouldCleanupRawClips,
} = require("../../src/lib/video-engine/services/scene-assets-disk.ts");

function makeRunDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bilal-drive-rebuild-"));
  fs.writeFileSync(
    path.join(dir, "scenes.json"),
    JSON.stringify(
      [
        { index: 0, text: "Provider scene.", visual_prompt: "Provider video.", duration_hint_sec: 6 },
        { index: 1, text: "Still fallback scene.", visual_prompt: "Still motion.", duration_hint_sec: 6 },
        { index: 2, text: "Stock fallback scene.", visual_prompt: "Stock video.", duration_hint_sec: 6 },
      ],
      null,
      2
    )
  );
  fs.writeFileSync(path.join(dir, "voiceover_full.mp3"), "fake-mp3");
  fs.mkdirSync(path.join(dir, "animations"), { recursive: true });

  for (const index of [0, 1, 2]) {
    const stem = `scene_${String(index).padStart(3, "0")}`;
    fs.writeFileSync(path.join(dir, "animations", `${stem}.mp4`), `fake-mp4-${index}`);
  }
  fs.writeFileSync(
    path.join(dir, "animations", "scene_001.manifest.json"),
    JSON.stringify({ sourceMode: "still-motion-fallback", provider: "local-still" })
  );
  fs.writeFileSync(
    path.join(dir, "animations", "scene_002.manifest.json"),
    JSON.stringify({ sourceMode: "stock-fallback", provider: "drive-stock" })
  );
  fs.writeFileSync(path.join(dir, "animations", "buffer_kenburns.mp4"), "buffer");
  return dir;
}

console.log("Test 1 - raw clip reconstruction keeps fallback clips uploadable:");
{
  const dir = makeRunDir();
  try {
    const assets = rebuildSceneAssetsFromDisk(dir);
    assert.equal(assets.length, 3);
    assert.equal(assets.every((asset) => !!asset.videoPath && fs.existsSync(asset.videoPath)), true);
    assert.equal(assets[0].sourceMode, null);
    assert.equal(assets[1].sourceMode, "still-motion-fallback");
    assert.equal(assets[1].fallbackKind, "still-motion");
    assert.equal(assets[2].sourceMode, "stock-fallback");
    assert.equal(assets[2].fallbackKind, "stock");
    assert.equal(assets.every((asset) => asset.audio.filePath.endsWith("voiceover_full.mp3")), true);
    assert.equal(countRawClipsOnDisk(dir), 3);
    console.log("  ok");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log("Test 2 - metadata reader marks fallback clips without touching the DB:");
{
  const dir = makeRunDir();
  try {
    const still = readSceneVideoMetadata(path.join(dir, "animations", "scene_001.mp4"));
    const stock = readSceneVideoMetadata(path.join(dir, "animations", "scene_002.mp4"));
    const provider = readSceneVideoMetadata(path.join(dir, "animations", "scene_000.mp4"));
    assert.equal(still.fallbackKind, "still-motion");
    assert.equal(stock.fallbackKind, "stock");
    assert.equal(provider.fallbackKind, null);
    console.log("  ok");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log("Test 3 - cleanup guard only allows complete uploads:");
assert.equal(shouldCleanupRawClips(0, 1), false);
assert.equal(shouldCleanupRawClips(1, 2), false);
assert.equal(shouldCleanupRawClips(0, 0), false);
assert.equal(shouldCleanupRawClips(3, 3), true);
console.log("  ok");

console.log("Test 4 - mismatched raw clips trigger the empty-manifest guard condition:");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bilal-empty-manifest-"));
  try {
    fs.writeFileSync(
      path.join(dir, "scenes.json"),
      JSON.stringify([{ index: 0, text: "x", visual_prompt: "y", duration_hint_sec: 6 }])
    );
    fs.mkdirSync(path.join(dir, "animations"), { recursive: true });
    fs.writeFileSync(path.join(dir, "animations", "scene_005.mp4"), "orphan");
    const assets = rebuildSceneAssetsFromDisk(dir);
    const guardWouldThrow = assets.length === 0 && fs.existsSync(path.join(dir, "scenes.json")) && countRawClipsOnDisk(dir) > 0;
    assert.equal(assets.length, 0);
    assert.equal(countRawClipsOnDisk(dir), 1);
    assert.equal(guardWouldThrow, true);
    console.log("  ok");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
