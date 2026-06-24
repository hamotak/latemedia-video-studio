#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = process.cwd();
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf-8");

console.log("Test 1 - channel voice settings persist and sync into presets:");
{
  const store = read("src/lib/channels-store.ts");
  const route = read("src/app/api/studio/channels/[id]/route.ts");
  const bridge = read("src/lib/video-bridge.ts");
  for (const field of ["voice_speed", "voice_stability", "voice_similarity_boost", "voice_style"]) {
    assert.match(store, new RegExp(`${field} REAL`));
    assert.match(route, new RegExp(`\"${field}\"`));
    assert.match(bridge, new RegExp(`${field}: channel\\.${field}`));
  }
  assert.match(route, /patch\.voice_provider = "elevenlabs"/);
  assert.match(route, /VOICE_NUMBER_LIMITS/);
  assert.doesNotMatch(route, /"prompt_presets"/);
  assert.match(bridge, /const VOICE_PROVIDER = "elevenlabs"/);
  assert.match(bridge, /DELETE FROM prompt_presets WHERE studio_channel_id/);
  console.log("  ok");
}

console.log("Test 2 - standalone UI removes old admin and Drive surfaces:");
{
  const dashboard = read("src/app/admin/page.tsx");
  const video = read("src/app/studio/video/page.tsx");
  const settings = read("src/components/video-pipeline-settings.tsx");
  const userButton = read("src/components/user-button.tsx");
  assert.doesNotMatch(dashboard, /Employees/);
  assert.doesNotMatch(dashboard, /—\s*subs|subscribers/i);
  assert.doesNotMatch(video, />\s*Sync\s*</);
  assert.doesNotMatch(video, /syncDrive/);
  assert.doesNotMatch(settings, /Advanced \(optional\)/);
  assert.doesNotMatch(userButton, /href="\/admin\/settings\/video"/);
  console.log("  ok");
}

console.log("Test 3 - settings and channel edit use the sidebar workspace chrome:");
{
  const shell = read("src/components/shell-wrapper.tsx");
  const settingsLayout = read("src/app/admin/settings/layout.tsx");
  const channelEdit = read("src/app/admin/channels/[id]/page.tsx");
  assert.doesNotMatch(shell, /pathname\.startsWith\("\/admin\/settings"\)/);
  assert.doesNotMatch(settingsLayout, /AdminPageShell/);
  assert.doesNotMatch(channelEdit, /AdminPageShell/);
  assert.match(channelEdit, /Go back/);
  console.log("  ok");
}

console.log("Test 4 - Bilal Demo branding is used in visible project surfaces:");
{
  const visibleFiles = [
    "README.md",
    "CLAUDE.md",
    "package.json",
    "package-lock.json",
    "install.bat",
    "start.bat",
    "src/app/layout.tsx",
    "src/components/admin-page-shell.tsx",
    "src/components/video-pipeline-settings.tsx",
  ];
  const oldPackageName = [[..."late"].join(""), [..."media"].join(""), "video", "studio"].join("-");
  const oldBrandPattern = new RegExp(`${["Late", "Media"].join(" ")}|${oldPackageName}`, "i");
  for (const rel of visibleFiles) {
    const source = read(rel);
    assert.doesNotMatch(source, oldBrandPattern);
  }
  assert.match(read("src/lib/video-engine/local-output.ts"), /Bilal Demo Videos/);
  assert.match(read("src/lib/video-engine/app-meta.ts"), /BILAL_DATA_DIR/);
  assert.match(read("src/lib/video-engine/app-meta.ts"), /\["LATE", "MEDIA", "DATA", "DIR"\]\.join\("_"\)/);
  console.log("  ok");
}

console.log("Test 5 - channel deletion is exposed in the list and cleans linked profile:");
{
  const channelsPage = read("src/app/admin/channels/page.tsx");
  const route = read("src/app/api/studio/channels/[id]/route.ts");
  assert.match(channelsPage, /method: "DELETE"/);
  assert.match(channelsPage, />\s*Delete\s*</);
  assert.doesNotMatch(channelsPage, /Clapperboard/);
  assert.match(route, /deletePresetForChannel\(channelId\)/);
  console.log("  ok");
}
