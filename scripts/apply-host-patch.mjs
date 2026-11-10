#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { checkHost, hostRoot } from "./host.mjs";

try {
  if (!process.argv[2]) throw new Error("Usage: node scripts/apply-host-patch.mjs PATH_TO_PI_PACKAGE");
  const root = hostRoot(process.argv[2]);
  try {
    checkHost(root);
    console.log("Pi 1.4.0 host patch already applied");
    process.exit(0);
  } catch {}
  checkHost(root, "original");
  const patch = readFileSync(new URL("../patches/pi-coding-agent-1.4.0.patch", import.meta.url));
  for (const args of [["--dry-run", "-p1"], ["-p1"]]) {
    const result = spawnSync("patch", args, { cwd: root, input: patch, encoding: "utf8" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stdout + result.stderr);
  }
  checkHost(root);
  console.log("Applied minimal Pi 1.4.0 host patch; use pi-progressive-compression, not the upstream bundled pi executable");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
