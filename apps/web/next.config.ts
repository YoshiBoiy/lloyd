import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  distDir: process.env.LLOYD_NEXT_DIST_DIR ?? ".next",
  outputFileTracingRoot: repoRoot,
  serverExternalPackages: ["mongodb", "pg", "fastify"],
  webpack(config) {
    config.resolve.extensionAlias = { ...config.resolve.extensionAlias, ".js": [".ts", ".tsx", ".js"] };
    return config;
  },
};

export default nextConfig;
