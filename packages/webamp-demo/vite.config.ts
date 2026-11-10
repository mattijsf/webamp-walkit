import { defineConfig } from "vite";
import nodePolyfills from "rollup-plugin-polyfill-node";

export default defineConfig({
  // GitHub Pages serves the demo under the repository's name
  base: process.env.DEMO_BASE ?? "/",
  build: {
    outDir: "dist",
    chunkSizeWarningLimit: 2500,
  },
  assetsInclude: ["**/*.wsz", "**/*.wal", "**/*.mp3", "**/*.wasm"],
  plugins: [
    // Needed for music-metadata-browser which uses polyfillable node APIs
    // @ts-expect-error Rollup plugin type mismatch with Vite's stricter types
    nodePolyfills(),
  ],
});
