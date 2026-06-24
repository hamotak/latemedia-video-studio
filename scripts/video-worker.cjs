#!/usr/bin/env node

const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const ts = require("typescript");

const originalLoad = Module._load;
Module._load = function patchedVideoWorkerLoad(request, parent, isMain) {
  if (request === "server-only") return {};
  if (request.startsWith("@/")) {
    return originalLoad.call(this, path.join(process.cwd(), "src", request.slice(2)), parent, isMain);
  }
  return originalLoad.call(this, request, parent, isMain);
};

require.extensions[".ts"] = (mod, filename) => {
  const source = fs.readFileSync(filename, "utf-8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  });
  mod._compile(outputText, filename);
};

async function main() {
  const [, , action, runId, token] = process.argv;
  const pipeline = require(path.join(
    process.cwd(),
    "src/lib/video-engine/pipeline.ts"
  ));

  if (action === "self-test") {
    return;
  }

  if ((action !== "run" && action !== "resume") || !runId || !token) {
    throw new Error("Usage: node scripts/video-worker.cjs <run|resume> <runId> <token>");
  }

  const { runVideoWorkerProcess } = pipeline;
  await runVideoWorkerProcess(action, runId, token);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack || e.message : String(e));
  process.exitCode = 1;
});
