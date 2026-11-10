#!/usr/bin/env node
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { checkHost, packageRoot } from "./host.mjs";

// This directory belongs only to this checkout, never the user's existing Pi.
const directory = resolve(packageRoot, ".host");
const root = resolve(directory, "node_modules/@earendil-works/pi-coding-agent");
function run(command, args) {
  const result = spawnSync(command, args, { cwd: directory, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})`);
}
try {
  let ready = false;
  try { checkHost(root); ready = true; } catch {}
  if (!ready) {
    mkdirSync(directory, { recursive: true });
    const manifest = resolve(directory, "package.json");
    if (!existsSync(manifest)) writeFileSync(manifest, JSON.stringify({ private: true, dependencies: { "@earendil-works/pi-coding-agent": "1.4.0" } }, null, 2) + "\n", { flag: "wx" });
    console.log("Installing an isolated Pi 1.4.0 host in .host (existing Pi is untouched).");
    // Copy, not hardlink: applying the patch must never change Bun's shared cache.
    run("bun", ["install", "--ignore-scripts", "--backend", "copy"]);
    run(process.execPath, [resolve(packageRoot, "scripts/apply-host-patch.mjs"), root]);
    checkHost(root);
  }
  console.log("Ready. Run bun start. Your normal Pi login, settings, extensions and sessions are used.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
