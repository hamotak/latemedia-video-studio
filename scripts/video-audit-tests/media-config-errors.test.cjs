#!/usr/bin/env node

const assert = require("node:assert/strict");

require("./register-ts.cjs");

const {
  isNonRetriableMediaConfigError,
  sanitizeMediaErrorMessage,
  sanitizeMediaLogData,
} = require("../../src/lib/video-engine/media-errors.ts");

console.log("Test 1 - missing provider keys are non-retriable media config errors:");
{
  assert.equal(isNonRetriableMediaConfigError("LABS69_API_KEY is not set (Settings)"), true);
  assert.equal(isNonRetriableMediaConfigError("GOOGLE_API_KEY is not set — needed for AI matching"), true);
  assert.equal(isNonRetriableMediaConfigError("OPENAI_API_KEY is not set"), true);
  assert.equal(isNonRetriableMediaConfigError("69labs images job abc FAILED: This job failed to complete."), false);
  assert.equal(isNonRetriableMediaConfigError("polling timeout after 480000ms"), false);
  console.log("  ok");
}

console.log("Test 2 - provider error sanitizing redacts credentials before logs/API errors:");
{
  const raw =
    "69labs status tts/job 401: Authorization: Bearer sk-secret-token-1234567890 " +
    "https://provider.test?api_key=abc123secret&voice=ok client_secret=topsecret refresh_token=refreshme";
  const clean = sanitizeMediaErrorMessage(raw);
  assert.equal(clean.includes("sk-secret-token-1234567890"), false);
  assert.equal(clean.includes("abc123secret"), false);
  assert.equal(clean.includes("topsecret"), false);
  assert.equal(clean.includes("refreshme"), false);
  assert.match(clean, /\[redacted\]/);

  assert.deepEqual(sanitizeMediaLogData({
    prompt: "safe prompt",
    Authorization: "Bearer should-not-leak",
    nested: { access_token: "token-value", message: "Bearer token-value" },
  }), {
    prompt: "safe prompt",
    Authorization: "[redacted]",
    nested: { access_token: "[redacted]", message: "Bearer [redacted]" },
  });
  console.log("  ok");
}
