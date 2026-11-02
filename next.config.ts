import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Pin the output tracing root so `next build` emits a flat
  // .next/standalone/server.js (Next 16 otherwise nests the standalone
  // bundle under a project subfolder when it detects a parent workspace).
  outputFileTracingRoot: process.cwd(),
  typescript: {
    // `npm run typecheck` is the strict gate (CI runs it as its own job);
    // the build stays responsible only for bundling.
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
