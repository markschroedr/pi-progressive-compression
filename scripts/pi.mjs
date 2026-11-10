#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkHost, hostRoot, packageRoot } from "./host.mjs";

try {
  const root = checkHost(hostRoot());
  if (process.argv[2] === "--check-host") {
    console.log("Pi 1.4.0 continuous-context host: compatible; entrypoint dist/cli.js (unbundled)");
  } else {
    // The upstream bin points at an independent bundle which does not use patched modules.
    process.argv.splice(2, 0, "--extension", resolve(packageRoot, "src/index.ts"));
    await import(pathToFileURL(resolve(root, "dist/cli.js")).href);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
