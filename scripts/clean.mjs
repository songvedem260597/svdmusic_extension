// Resilient dist cleaner.
// Vite's default `emptyOutDir: true` fails with EBUSY on Windows whenever
// Chrome or another process is briefly holding a file in dist/. When that
// happens the whole build aborts mid-wipe, leaving the extension
// un-loadable because manifest.json is missing.
//
// This script only deletes the files Vite itself produces
// (dist/assets/ and dist/sidepanel.html), and ignores individual file
// errors so a single locked file doesn't abort the rest of the build.

import { existsSync, rmSync, readdirSync, statSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(__dirname, "..", "dist");

// Targets that Vite/React emit. Safe to wipe — they'll be recreated.
const viteTargets = ["assets", "sidepanel.html"];

function safeRemove(target) {
  const fullPath = join(distDir, target);
  if (!existsSync(fullPath)) return;
  try {
    rmSync(fullPath, { recursive: true, force: true });
    console.log(`Cleaned ${target}`);
  } catch (err) {
    // Don't abort the build on a single locked file. Surface it but keep going.
    console.warn(`Skipped ${target}: ${err.code || err.message}`);
  }
}

if (!existsSync(distDir)) {
  console.log("dist/ does not exist yet — nothing to clean.");
} else {
  for (const t of viteTargets) safeRemove(t);
}

console.log("Clean complete.");
