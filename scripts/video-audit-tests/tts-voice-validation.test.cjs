#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ttsPath = path.join(process.cwd(), "src/lib/video-engine/services/tts.ts");
const labs69Path = path.join(process.cwd(), "src/lib/video-engine/services/labs69.ts");
const runRoutePath = path.join(process.cwd(), "src/app/api/video/runs/route.ts");
const resumeRoutePath = path.join(process.cwd(), "src/app/api/video/runs/[id]/reassemble/route.ts");
const settingsPath = path.join(process.cwd(), "src/lib/video-engine/settings.ts");
const voicesPath = path.join(process.cwd(), "src/lib/video-engine/voices.ts");
const promptsPath = path.join(process.cwd(), "src/lib/video-engine/prompts.ts");

const ttsSource = fs.readFileSync(ttsPath, "utf-8");
const labs69Source = fs.readFileSync(labs69Path, "utf-8");
const runRouteSource = fs.readFileSync(runRoutePath, "utf-8");
const resumeRouteSource = fs.readFileSync(resumeRoutePath, "utf-8");
const settingsSource = fs.readFileSync(settingsPath, "utf-8");
const voicesSource = fs.readFileSync(voicesPath, "utf-8");
const promptsSource = fs.readFileSync(promptsPath, "utf-8");
const retiredProviderToken = "edge" + "tts";
const retiredEngineLabel = "Edge " + "TTS";
const retiredModelToken = "edge" + "-tts";
const retiredVoiceId = ["en-US", "GuyNeural"].join("-");
const retiredProviderPattern = new RegExp(
  `${retiredProviderToken}|${retiredEngineLabel}|${retiredModelToken}|${retiredVoiceId}`,
  "i"
);

console.log("Test 1 - voice sample validation key includes run voice tuning:");
{
  assert.match(ttsSource, /export interface VoiceSampleValidationOptions/);
  assert.match(ttsSource, /speedOverride\?: number \| null/);
  assert.match(ttsSource, /stabilityOverride\?: number \| null/);
  assert.match(ttsSource, /similarityOverride\?: number \| null/);
  assert.match(ttsSource, /voiceStyleOverride\?: number \| null/);

  assert.match(ttsSource, /const settings = voiceSampleJobSettings\(voiceProvider, options\)/);
  assert.match(ttsSource, /voiceSettings: settings\.voiceSettings/);
  assert.match(ttsSource, /minimaxSettings: settings\.minimaxSettings/);
  assert.match(ttsSource, /autoPauseEnabled: settings\.autoPauseEnabled/);
  assert.match(ttsSource, /autoPauseDuration: settings\.autoPauseDuration/);
  assert.match(ttsSource, /autoPauseFrequency: settings\.autoPauseFrequency/);

  const keyIndex = ttsSource.indexOf("function voiceSampleValidationKey");
  const jobSettingsIndex = ttsSource.indexOf("const settings = voiceSampleJobSettings(voiceProvider, options);", keyIndex);
  const cacheGetIndex = ttsSource.indexOf("voiceSampleValidationCache.get(key)");
  assert.ok(keyIndex >= 0, "voice sample cache key helper is missing");
  assert.ok(jobSettingsIndex > keyIndex, "cache key should be built from normalized sample job settings");
  assert.ok(cacheGetIndex > jobSettingsIndex, "cache lookup should happen after settings are part of the key");
  console.log("  ok");
}

console.log("Test 3 - active video backend no longer routes through the retired voice engine:");
{
  const activeTtsSources = [
    ttsSource,
    labs69Source,
    runRouteSource,
    resumeRouteSource,
    settingsSource,
    voicesSource,
    promptsSource,
  ].join("\n");
  assert.doesNotMatch(activeTtsSources, retiredProviderPattern);

  assert.match(ttsSource, /export function normalizeTtsVoiceProvider\(provider: string\): Labs69VoiceProvider/);
  assert.match(ttsSource, /return v === "voice-clone" \|\| v === "minimax" \? v : "elevenlabs"/);
  assert.match(ttsSource, /DEFAULT_ELEVENLABS_MODEL = "eleven_multilingual_v2"/);
  assert.match(ttsSource, /rawModel\.toLowerCase\(\)\.startsWith\("eleven_"\) \? rawModel : DEFAULT_ELEVENLABS_MODEL/);
  assert.doesNotMatch(ttsSource, /createTtsJobWithEdgeModelFallback/);
  assert.doesNotMatch(
    labs69Source,
    new RegExp(`voiceProvider\\?: "elevenlabs" \\| "${retiredProviderToken}"`)
  );
  console.log("  ok");
}

console.log("Test 2 - run creation and resume validate the actual preset voice settings:");
{
  assert.match(runRouteSource, /type VoiceSampleValidationOptions/);
  assert.match(runRouteSource, /speedOverride: preset\.voice_speed/);
  assert.match(runRouteSource, /stabilityOverride: preset\.voice_stability/);
  assert.match(runRouteSource, /similarityOverride: preset\.voice_similarity_boost/);
  assert.match(runRouteSource, /voiceStyleOverride: preset\.voice_style/);
  assert.match(runRouteSource, /validateTtsVoiceSample\(voiceId, provider, validationOptions\)/);

  assert.match(resumeRouteSource, /preset_voice_speed/);
  assert.match(resumeRouteSource, /preset_voice_stability/);
  assert.match(resumeRouteSource, /preset_voice_similarity_boost/);
  assert.match(resumeRouteSource, /preset_voice_style/);
  assert.match(resumeRouteSource, /speedOverride: row\?\.preset_voice_speed \?\? null/);
  assert.match(resumeRouteSource, /stabilityOverride: row\?\.preset_voice_stability \?\? null/);
  assert.match(resumeRouteSource, /similarityOverride: row\?\.preset_voice_similarity_boost \?\? null/);
  assert.match(resumeRouteSource, /voiceStyleOverride: row\?\.preset_voice_style \?\? null/);
  assert.match(resumeRouteSource, /validateTtsVoiceSample\(voiceId, provider, validationOptions\)/);
  console.log("  ok");
}
