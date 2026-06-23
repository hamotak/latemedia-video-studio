#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

require("./register-ts.cjs");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "late-media-export-state-"));
process.env.LATE_MEDIA_DATA_DIR = dataDir;

const { readRunExportState } = require("../../src/lib/video-engine/run-export-state.ts");

function runDir(runId) {
  const dir = path.join(dataDir, "runs", runId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFinal(dir) {
  fs.writeFileSync(path.join(dir, "final.mp4"), "fake-final-mp4");
}

function writeScenes(dir, scenes) {
  fs.writeFileSync(path.join(dir, "scenes.json"), typeof scenes === "string" ? scenes : JSON.stringify(scenes, null, 2));
}

try {
  console.log("Test 1 - final export with cleaned raw folders stays ready:");
  {
    const dir = runDir("cleaned-raw-final");
    writeFinal(dir);
    writeScenes(dir, [{ index: 0, text: "A complete sentence keeps this scene plan healthy.", source_kind: "fresh" }]);
    const state = readRunExportState("cleaned-raw-final", "done", { mode: "full" });
    assert.equal(fs.existsSync(path.join(dir, "animations")), false);
    assert.equal(state.finalFileExists, true);
    assert.equal(state.finalReady, true);
    assert.equal(state.finalNeedsRepair, false);
    console.log("  ok");
  }

  console.log("Test 2 - missing scenes.json does not hide a valid final:");
  {
    const dir = runDir("missing-scenes");
    writeFinal(dir);
    const state = readRunExportState("missing-scenes", "done");
    assert.equal(state.scenePlanPresent, false);
    assert.equal(state.finalReady, true);
    assert.equal(state.canRepairPlan, false);
    console.log("  ok");
  }

  console.log("Test 3 - corrupt scenes.json does not hide a valid final:");
  {
    const dir = runDir("corrupt-scenes");
    writeFinal(dir);
    writeScenes(dir, "{ definitely not json");
    const state = readRunExportState("corrupt-scenes", "done");
    assert.equal(state.scenePlanPresent, true);
    assert.equal(state.scenePlanParsed, false);
    assert.equal(state.finalReady, true);
    assert.equal(state.finalNeedsRepair, false);
    console.log("  ok");
  }

  console.log("Test 4 - old micro-chunk full exports still require repair:");
  {
    const dir = runDir("micro-chunk-final");
    writeFinal(dir);
    writeScenes(dir, [
      { text: "Before the smoke and the pistols and" },
      { text: "the name that made harbor masters sweat," },
      { text: "there was just a man. A young one, probably from Bristol, England," },
      { text: "though the records from that period are thin" },
      { text: "and the details blur at the edges." },
      { text: "Bristol in the late sixteen hundreds is a port city." },
      { text: "It smells like tar and fish and the" },
      { text: "river at low tide." },
    ]);
    const state = readRunExportState("micro-chunk-final", "done", { mode: "full" });
    assert.equal(state.scenePlanParsed, true);
    assert.equal(state.scenePlanHealth.ok, false);
    assert.equal(state.finalReady, true);
    assert.equal(state.finalNeedsRepair, true);
    assert.equal(state.canRepairPlan, true);
    console.log("  ok");
  }

  console.log("Test 5 - hybrid stock tail chunks do not block final readiness:");
  {
    const dir = runDir("hybrid-stock-tail");
    writeFinal(dir);
    writeScenes(dir, [
      { source_kind: "stock", text: "The harbor fell silent while" },
      { source_kind: "stock", text: "the black flag appeared above the mast." },
    ]);
    const state = readRunExportState("hybrid-stock-tail", "done", { mode: "hybrid" });
    assert.equal(state.scenePlanParsed, true);
    assert.equal(state.scenePlanHealth.ok, true);
    assert.equal(state.finalReady, true);
    assert.match(String(state.scenePlanHealth.issue ?? ""), /continuous voiceover/);
    console.log("  ok");
  }
} finally {
  const db = require("../../src/lib/video-engine/db.ts").default;
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
