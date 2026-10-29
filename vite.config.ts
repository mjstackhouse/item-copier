import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The migration toolkit is built for Node.js and does not document browser support. Two Node-only
 * modules are imported at the top level of code the copy path never runs (zip/report file writing
 * and the terminal spinner). These aliases swap them for small stubs so the bundle builds for the browser.
 * The toolkit also needs two runtime changes, applied with patch-package (see patches/).
 */
const shim = (file: string) => fileURLToPath(new URL(`./shims/${file}`, import.meta.url));

/**
 * Vite's development server caches pre-bundled dependencies and only notices a change to patches/
 * when the folder itself changes, not when a patch file is rewritten. A stale cache would run the
 * toolkit without the patches (in "Copy as drafts" mode it would then unpublish live items), so the
 * patch contents are made part of the cache key below.
 */
const patchesDir = fileURLToPath(new URL("./patches", import.meta.url));
const patchesHash = existsSync(patchesDir)
  ? createHash("sha256")
      .update(
        readdirSync(patchesDir)
          .sort()
          .map((file) => file + readFileSync(`${patchesDir}/${file}`, "utf-8"))
          .join("\n"),
      )
      .digest("hex")
  : "none";

export default defineConfig({
  plugins: [react()],
  // The toolkit and the Management SDK make one large bundle; that is expected for this tool.
  build: { chunkSizeWarningLimit: 1500 },
  resolve: {
    alias: {
      "node:fs/promises": shim("fs.ts"),
      "node:fs": shim("fs.ts"),
      ora: shim("ora.ts"),
    },
  },
  // The esbuild options are part of Vite's dependency cache key; the defined name is never used.
  optimizeDeps: { esbuildOptions: { define: { __TOOLKIT_PATCHES_HASH__: JSON.stringify(patchesHash) } } },
});
