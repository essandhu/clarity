import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // jsdom (arrives in increment 3) must stay external to the server bundle —
  // bundling it breaks at build/runtime.
  serverExternalPackages: ["jsdom"],
  // Compression buffers SSE frames; the streaming routes need every frame
  // flushed as it is emitted. This is a local-first tool — gzip buys nothing.
  compress: false,
};

export default nextConfig;
