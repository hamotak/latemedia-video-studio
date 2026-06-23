import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep native / binary-bearing packages out of Next's server bundler so the
  // native addon (better-sqlite3) and the bundled ffmpeg/ffprobe executables
  // resolve correctly at runtime.
  serverExternalPackages: [
    "better-sqlite3",
    "fluent-ffmpeg",
    "ffmpeg-static",
    "ffprobe-static",
  ],
};

export default nextConfig;
