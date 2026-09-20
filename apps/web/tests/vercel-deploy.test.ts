import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import nextConfig from "../next.config";

const webRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(webRoot, "../..");

it("installs the Next app by changing into apps/web so npm ci uses that lockfile", () => {
  const vercel = JSON.parse(readFileSync(path.join(webRoot, "vercel.json"), "utf8")) as {
    installCommand: string;
  };
  expect(vercel.installCommand).toContain("cd apps/web && npm ci");
  expect(vercel.installCommand).not.toMatch(/--prefix/);
});

it("keeps the web lockfile in sync with package.json, including emnapi optional bindings", () => {
  const pkg = JSON.parse(readFileSync(path.join(webRoot, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  const lock = JSON.parse(readFileSync(path.join(webRoot, "package-lock.json"), "utf8")) as {
    packages: Record<string, { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; version?: string }>;
  };
  const root = lock.packages[""];
  expect(root.dependencies).toEqual(pkg.dependencies);
  expect(root.devDependencies).toEqual(pkg.devDependencies);
  expect(lock.packages["node_modules/@emnapi/core"]?.version).toMatch(/^\d+\./);
  expect(lock.packages["node_modules/@emnapi/runtime"]?.version).toMatch(/^\d+\./);
});

it("traces the monorepo from the repository root so hosted API imports resolve on Vercel", async () => {
  const config = await nextConfig;
  expect(path.resolve(config.outputFileTracingRoot ?? "")).toBe(repoRoot);
});
