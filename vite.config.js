import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    // Debug: keep unminified JS + line-accurate sourcemaps so runtime
    // `ReferenceError: Cannot access 'X' before initialization` points
    // back at the actual source file/line instead of a minified alias.
    // Toggle back off (remove these two keys) once the bug is fixed.
    sourcemap: true,
    minify: false,
    // Leave cleanup to scripts/clean.mjs so we can be precise about which
    // files we wipe. Default `emptyOutDir: true` triggers EBUSY on Windows
    // whenever Chrome is holding a file in dist/, which can leave the
    // extension un-loadable (manifest.json missing) until the next build.
    emptyOutDir: false,
    rollupOptions: {
      input: {
        sidepanel: resolve(__dirname, "sidepanel.html"),
      },
    },
  },
});
