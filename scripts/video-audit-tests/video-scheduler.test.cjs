#!/usr/bin/env node

const assert = require("node:assert/strict");

require("./register-ts.cjs");

const {
  normalizeVideoHedgeConfig,
  shouldLaunchVideoHedge,
} = require("../../src/lib/video-engine/generation-scheduler.ts");
const { pLimit } = require("../../src/lib/video-engine/plimit.ts");
const { runOrderedLimited } = require("../../src/lib/video-engine/ordered-limiter.ts");

console.log("Test 1 - video hedge launches only after delay with a spare slot:");
{
  const cfg = normalizeVideoHedgeConfig("1", "3");
  assert.deepEqual(cfg, { maxAttempts: 3, maxParallel: 3 });
  assert.equal(
    shouldLaunchVideoHedge({
      elapsedMs: 180_000,
      hedgeAfterMs: 180_000,
      launchedAttempts: 1,
      activeAttempts: 1,
      maxAttempts: cfg.maxAttempts,
      maxParallel: cfg.maxParallel,
      spareSlotAvailable: true,
    }),
    true
  );
  assert.equal(
    shouldLaunchVideoHedge({
      elapsedMs: 179_999,
      hedgeAfterMs: 180_000,
      launchedAttempts: 1,
      activeAttempts: 1,
      maxAttempts: cfg.maxAttempts,
      maxParallel: cfg.maxParallel,
      spareSlotAvailable: true,
    }),
    false
  );
  assert.equal(
    shouldLaunchVideoHedge({
      elapsedMs: 180_000,
      hedgeAfterMs: 180_000,
      launchedAttempts: 1,
      activeAttempts: 1,
      maxAttempts: cfg.maxAttempts,
      maxParallel: cfg.maxParallel,
      spareSlotAvailable: false,
    }),
    false
  );
  console.log("  ok");
}

console.log("Test 2 - ordered limited jobs run concurrently but return in input order:");
(async () => {
  const limit = pLimit(2);
  const delays = [30, 5, 10];
  let active = 0;
  let maxActive = 0;
  const results = await runOrderedLimited(
    delays,
    async (delay, index) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, delay));
      active--;
      return index;
    },
    limit
  );

  assert.deepEqual(results, [0, 1, 2]);
  assert.equal(maxActive, 2, "Limiter should allow concurrent chunk work.");
  console.log("  ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
