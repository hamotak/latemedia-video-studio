#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const routePath = path.join(process.cwd(), "src/app/api/video/runs/[id]/reassemble/route.ts");
const source = fs.readFileSync(routePath, "utf-8");

console.log("Test 1 - video resume route hydrates provider settings before starting worker:");
{
  assert.match(source, /loadProviderSecretsIntoCache/);
  assert.match(source, /loadAppSettingsIntoCache/);
  assert.match(source, /Promise\.allSettled/);
  assert.match(source, /runPreflight/);
  assert.match(source, /preflight_failed/);
  assert.match(source, /resumeVoiceConfigured/);
  assert.match(source, /resumeVoiceValidationError/);
  assert.match(source, /voice_invalid/);
  assert.match(source, /retiredVideoModeError/);
  assert.match(source, /errorKind: "mode_retired"/);
  const hydrateIndex = source.indexOf("await hydrateRuntimeConfig(id)");
  const retiredModeIndex = source.indexOf('errorKind: "mode_retired"');
  const canResumeIndex = source.indexOf("canResumeRun(id)");
  const preflightIndex = source.indexOf("const preflight = runPreflight");
  const voiceValidationIndex = source.indexOf("const invalidVoice = await resumeVoiceValidationError");
  const startIndex = source.indexOf("startResumeRun(id)");
  assert.ok(hydrateIndex >= 0, "runtime config hydration call is missing from POST");
  assert.ok(retiredModeIndex > hydrateIndex, "retired modes should be rejected after settings hydration");
  assert.ok(canResumeIndex > retiredModeIndex, "saved scene plan should be checked after retired-mode rejection");
  assert.ok(preflightIndex > canResumeIndex, "preflight should run after confirming the run can resume");
  assert.ok(voiceValidationIndex > preflightIndex, "voice validation should run after required preflight passes");
  assert.ok(startIndex > hydrateIndex, "resume worker should start after settings hydration");
  assert.ok(startIndex > voiceValidationIndex, "resume worker should start only after voice validation passes");
  console.log("  ok");
}
