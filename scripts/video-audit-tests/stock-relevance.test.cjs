#!/usr/bin/env node

const assert = require("node:assert/strict");

require("./register-ts.cjs");

const {
  createShuffledStockDeckPicker,
  filterObviouslyOffTopicStock,
} = require("../../src/lib/video-engine/stock-relevance.ts");

console.log("Test 1 - obvious sports clips are filtered when maritime clips exist:");
{
  const maritime = {
    localPath: "/tmp/pirate-ship-rigging.mp4",
    clip: { name: "sleepy pirate ship rigging.mp4", driveFileId: "ship" },
  };
  const sports = {
    localPath: "/tmp/basketball-stadium.mp4",
    clip: { name: "basketball stadium player match.mp4", driveFileId: "sports" },
  };
  const filtered = filterObviouslyOffTopicStock([sports, maritime]);
  assert.deepEqual(filtered, [maritime]);

  const plan = createShuffledStockDeckPicker([sports, maritime], "stock-filter-test");
  assert.equal(plan.deckSize, 1);
  assert.equal(plan.pick(), maritime.localPath);
  assert.equal(plan.pick(), maritime.localPath);
  console.log("  ok");
}

console.log("Test 2 - filter falls back to original list rather than emptying a deck:");
{
  const candidates = [
    {
      localPath: "/tmp/football-stadium.mp4",
      clip: { name: "football stadium.mp4", driveFileId: "only" },
    },
  ];
  assert.deepEqual(filterObviouslyOffTopicStock(candidates), candidates);
  console.log("  ok");
}

console.log("Test 3 - generic generated stock is skipped when a maritime deck has named clips:");
{
  const named = [
    {
      localPath: "/tmp/pirate-ship-rigging.mp4",
      clip: { name: "sleepy pirate ship rigging.mp4", driveFileId: "ship-1" },
    },
    {
      localPath: "/tmp/wooden-harbor-sail.mp4",
      clip: { name: "wooden harbor sail.mp4", driveFileId: "ship-2" },
    },
    {
      localPath: "/tmp/ocean-deck-rope.mp4",
      clip: { name: "ocean deck rope.mp4", driveFileId: "ship-3" },
    },
  ];
  const ambiguous = {
    localPath: "/tmp/Pirates/abc__gen_mqg7r8xo_004.mp4",
    clip: { name: "gen_mqg7r8xo_004.mp4", driveFileId: "ambiguous" },
  };

  const filtered = filterObviouslyOffTopicStock([...named, ambiguous]);
  assert.deepEqual(filtered, named);
  console.log("  ok");
}

console.log("Test 4 - generic generated stock is kept when it is the only usable deck:");
{
  const ambiguous = {
    localPath: "/tmp/Pirates/abc__gen_mqg7r8xo_004.mp4",
    clip: { name: "gen_mqg7r8xo_004.mp4", driveFileId: "ambiguous" },
  };
  assert.deepEqual(filterObviouslyOffTopicStock([ambiguous]), [ambiguous]);
  console.log("  ok");
}
