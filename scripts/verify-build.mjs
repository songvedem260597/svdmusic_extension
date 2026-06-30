// Verifies the built extension does NOT include any key material or
// accidentally-included node_modules. This is a safety check before the
// user loads the unpacked extension in Chrome.
//
// Fail loudly if anything that looks like a private key, public key, or
// node_modules tree is found inside dist/.
//
// Also asserts that dist/manifest.json exists and is valid JSON — without
// it Chrome cannot load the extension at all (manifest unreadable error).

import { readdirSync, statSync, readFileSync, existsSync } from "fs";
import { resolve, dirname, relative } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const distDir = resolve(rootDir, "dist");

const manifestPath = resolve(distDir, "manifest.json");
if (!existsSync(manifestPath)) {
  console.error("[verify-build] FAIL — dist/manifest.json is missing. Chrome will refuse to load the extension.");
  process.exit(1);
}
try {
  JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (err) {
  console.error(`[verify-build] FAIL — dist/manifest.json is not valid JSON: ${err.message}`);
  process.exit(1);
}

const FORBIDDEN_PATTERNS = [
  /(^|[\\/])node_modules([\\/]|$)/i,
  /\.pem$/i,
  /\.key$/i,
  /(^|[\\/])test([\\/]|$)/i,
];
const FORBIDDEN_CONTENT = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/];

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files;
}

const offenders = [];
for (const file of walk(distDir)) {
  const rel = relative(distDir, file);
  if (FORBIDDEN_PATTERNS.some((p) => p.test(rel))) {
    offenders.push({ file: rel, reason: "path" });
    continue;
  }
  if (/\.(js|css|html|json|svg|txt|lrc)$/i.test(file)) {
    try {
      const text = readFileSync(file, "utf8");
      for (const pattern of FORBIDDEN_CONTENT) {
        if (pattern.test(text)) {
          offenders.push({ file: rel, reason: "private-key-in-content" });
          break;
        }
      }
    } catch (_) {
      // binary or unreadable — ignore
    }
  }
}

if (offenders.length) {
  console.error("[verify-build] FAIL — extension output contains forbidden files:");
  for (const o of offenders) {
    console.error("  - " + o.file + " (" + o.reason + ")");
  }
  process.exit(1);
}

console.log("[verify-build] OK — dist/ is clean. No node_modules, no .pem, no test keys.");
