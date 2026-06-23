#!/usr/bin/env node

const assert = require("node:assert/strict");

require("./register-ts.cjs");

const {
  DEFAULT_IMAGE_MODEL,
  normalizeImageModelId,
  parseImageFallbackModels,
} = require("../../src/lib/video-engine/provider-models.ts");

console.log("Test 1 - stale Imagen image models normalize to the current default:");
{
  assert.equal(normalizeImageModelId("imagen-4"), DEFAULT_IMAGE_MODEL);
  assert.equal(normalizeImageModelId(" imagen-4-ultra "), DEFAULT_IMAGE_MODEL);
  assert.equal(normalizeImageModelId("nano-banana-2"), "nano-banana-2");
  console.log("  ok");
}

console.log("Test 2 - fallback list ignores duplicates and stale primary-equivalent models:");
{
  assert.deepEqual(
    parseImageFallbackModels("imagen-4,gpt-image-2,nano-banana-2,imagen-4-ultra,gpt-image-2", "nano-banana-pro"),
    ["gpt-image-2", "nano-banana-2"]
  );
  console.log("  ok");
}
