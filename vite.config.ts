import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The migration toolkit is built for Node.js and does not document browser support. Two Node-only
 * modules are imported at the top level of code the copy path never runs (zip/report file writing
 * and the terminal spinner). These aliases swap them for small stubs so the bundle builds for the browser.
 * The toolkit also needs one runtime fix in the browser, applied with patch-package (see patches/).
 */
const shim = (file: string) => fileURLToPath(new URL(`./shims/${file}`, import.meta.url));

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
});
