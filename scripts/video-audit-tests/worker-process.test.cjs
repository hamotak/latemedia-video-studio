#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const pipelinePath = path.join(process.cwd(), "src/lib/video-engine/pipeline.ts");
const cancellationPath = path.join(process.cwd(), "src/lib/video-engine/cancellation.ts");
const workerPath = path.join(process.cwd(), "scripts/video-worker.cjs");

const pipeline = fs.readFileSync(pipelinePath, "utf-8");
const cancellation = fs.readFileSync(cancellationPath, "utf-8");
const worker = fs.readFileSync(workerPath, "utf-8");

console.log("Test 1 - video runs launch a durable worker process:");
{
  assert.match(pipeline, /from "node:child_process"/);
  assert.match(pipeline, /function videoWorkerScriptPath\(\)/);
  assert.match(pipeline, /spawn\(process\.execPath, \[videoWorkerScriptPath\(\), action, runId, token\]/);
  assert.match(pipeline, /detached: true/);
  assert.match(pipeline, /worker\.log/);
  assert.match(pipeline, /stdio: \["ignore", workerLogFd, workerLogFd\]/);
  assert.match(pipeline, /child\.unref\(\)/);
  assert.match(pipeline, /export async function runVideoWorkerProcess/);
  assert.match(pipeline, /hydrateWorkerRuntimeConfig\(runId\)/);
  console.log("  ok");
}

console.log("Test 2 - child worker owns heartbeat and awaits the pipeline:");
{
  assert.match(pipeline, /async function runWorkerWithHeartbeat/);
  assert.match(pipeline, /touchWorkerHeartbeat\(runId, token\)/);
  assert.match(pipeline, /setInterval\(\(\) => touchWorkerHeartbeat\(runId, token\), 5000\)/);
  assert.match(pipeline, /await work\(token\)/);
  assert.match(pipeline, /removeWorkerHeartbeat\(runId, token\)/);
  console.log("  ok");
}

console.log("Test 3 - cancellation crosses process boundaries through run status:");
{
  assert.match(cancellation, /import db from "\.\/db"/);
  assert.match(cancellation, /SELECT status FROM runs WHERE id = \?/);
  assert.match(cancellation, /row\?\.status === "cancelled"/);
  assert.match(cancellation, /if \(isCancelled\(runId\)\)/);
  console.log("  ok");
}

console.log("Test 4 - worker script loads TypeScript pipeline and validates arguments:");
{
  assert.match(worker, /require\.extensions\["\.ts"\]/);
  assert.match(worker, /request === "server-only"/);
  assert.match(worker, /request\.startsWith\("@\/"\)/);
  assert.match(worker, /typescript/);
  assert.match(worker, /runVideoWorkerProcess/);
  assert.match(worker, /self-test/);
  assert.match(worker, /<run\|resume> <runId> <token>/);
  console.log("  ok");
}

console.log("Test 5 - worker self-test imports the real pipeline:");
{
  const result = spawnSync(process.execPath, [workerPath, "self-test"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env },
    timeout: 15_000,
  });
  assert.equal(
    result.status,
    0,
    [
      "Expected worker self-test to import the pipeline cleanly.",
      result.stdout && `stdout:\n${result.stdout}`,
      result.stderr && `stderr:\n${result.stderr}`,
    ].filter(Boolean).join("\n\n")
  );
  console.log("  ok");
}
