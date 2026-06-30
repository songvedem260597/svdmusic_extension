import { mkdirSync, existsSync, copyFileSync, readdirSync, statSync, rmSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const distDir = resolve(rootDir, "dist");

// Copy with retry. On Windows a file can be briefly locked by Chrome's
// extension loader; retrying a few times is enough to clear it.
function copyWithRetry(src, dst, attempts = 5, delayMs = 200) {
  mkdirSync(dirname(dst), { recursive: true });
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      copyFileSync(src, dst);
      return;
    } catch (err) {
      lastErr = err;
      // EBUSY/EPERM: back off briefly and retry
      if (err.code === "EBUSY" || err.code === "EPERM") {
        const wait = (i + 1) * delayMs;
        console.warn(`Retry ${i + 1}/${attempts} for ${src} (${err.code}, waiting ${wait}ms)`);
        const start = Date.now();
        while (Date.now() - start < wait) { /* spin-wait briefly */ }
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function copyDir(src, dst) {
  if (!existsSync(src)) return;
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = resolve(src, entry);
    const dstPath = resolve(dst, entry);
    if (statSync(srcPath).isDirectory()) {
      copyDir(srcPath, dstPath);
    } else {
      try {
        copyWithRetry(srcPath, dstPath);
      } catch (err) {
        console.warn(`Failed to copy ${srcPath}: ${err.code || err.message} (continuing)`);
      }
    }
  }
  console.log(`Copied ${src} -> ${dst}`);
}

// Always copy manifest.json LAST with retry. This is the most critical file —
// without it Chrome cannot load the extension at all.
function copyManifestLast() {
  const manifestSrc = resolve(rootDir, "manifest.json");
  const manifestDst = resolve(distDir, "manifest.json");
  if (!existsSync(manifestSrc)) {
    console.error("CRITICAL: source manifest.json is missing — cannot build extension.");
    process.exitCode = 1;
    return;
  }
  try {
    // Remove any old copy first so copyFileSync overwrites cleanly.
    if (existsSync(manifestDst)) {
      try { rmSync(manifestDst, { force: true }); } catch { /* ignore */ }
    }
    copyWithRetry(manifestSrc, manifestDst);
    console.log("Copied manifest.json");
  } catch (err) {
    console.error(`CRITICAL: failed to copy manifest.json after retries: ${err.code || err.message}`);
    process.exitCode = 1;
  }
}

copyDir(resolve(rootDir, "public/images"), resolve(distDir, "images"));
copyDir(resolve(rootDir, "public/audio"), resolve(distDir, "audio"));
copyDir(resolve(rootDir, "public/fonts"), resolve(distDir, "fonts"));
copyDir(resolve(rootDir, "public/lrc"), resolve(distDir, "lrc"));
copyDir(resolve(rootDir, "public/uploads/mp3"), resolve(distDir, "mp3"));
copyDir(resolve(rootDir, "public/uploads/image_song"), resolve(distDir, "image_song"));

function tryCopyFile(src, dst, label) {
  if (!existsSync(src)) return;
  try {
    if (existsSync(dst)) {
      try { rmSync(dst, { force: true }); } catch { /* ignore */ }
    }
    copyWithRetry(src, dst);
    console.log(`Copied ${label}`);
  } catch (err) {
    console.warn(`Failed to copy ${label}: ${err.code || err.message} (continuing)`);
  }
}

tryCopyFile(resolve(rootDir, "src/background.js"), resolve(distDir, "background.js"), "background.js");
tryCopyFile(resolve(rootDir, "src/gemini-content.js"), resolve(distDir, "gemini-content.js"), "gemini-content.js");

const iconsDir = resolve(rootDir, "icons");
const iconsDst = resolve(distDir, "icons");
const sizes = [16, 32, 48, 128];
mkdirSync(iconsDst, { recursive: true });
for (const size of sizes) {
  const src = resolve(iconsDir, `icon${size}.png`);
  const dst = resolve(iconsDst, `icon${size}.png`);
  tryCopyFile(src, dst, `icon${size}.png`);
}

// Manifest MUST be present in dist/ for Chrome to load the extension. Copy
// it last with retry to maximize the chance of success.
copyManifestLast();

console.log("Assets copied.");
