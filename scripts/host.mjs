import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const hashes = JSON.parse(readFileSync(new URL("../patches/host-files.json", import.meta.url), "utf8"));
export function hostRoot(explicit = process.env.PI_CONTINUOUS_CONTEXT_HOST) {
  return explicit ? resolve(explicit) : dirname(dirname(createRequire(import.meta.url).resolve("@earendil-works/pi-coding-agent")));
}
export function checkHost(root, variant = "patched") {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  if (pkg.name !== "@earendil-works/pi-coding-agent" || pkg.version !== "1.4.0") throw new Error("Requires Pi coding-agent 1.4.0");
  for (const [file, expected] of Object.entries(hashes)) {
    const actual = createHash("sha256").update(readFileSync(resolve(root, file))).digest("hex");
    if (actual !== expected[variant]) throw new Error(`Host file mismatch: ${file}. Use an isolated clean Pi 1.4.0 installation and apply the supplied patch; see INSTALL.md`);
  }
  return root;
}
