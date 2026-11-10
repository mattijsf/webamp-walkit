import { defineConfig } from "vite";
import nodePolyfills from "rollup-plugin-polyfill-node";

export default defineConfig({
  // relative, so the build works under any path, as GitHub Pages serves it under the
  // repository's name
  base: "./",
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
