import typescript from "@rollup/plugin-typescript";
import json from "@rollup/plugin-json";
import commonjs from "@rollup/plugin-commonjs";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import postcss from "rollup-plugin-postcss";
import terser from "@rollup/plugin-terser";
import { visualizer } from "rollup-plugin-visualizer";
import replace from "@rollup/plugin-replace";
import postcssOptimizeDataUriPngs from "./postcss-optimize-data-uri-pngs.mjs";
import atImport from "postcss-import";
import nodePolyfills from "rollup-plugin-polyfill-node";
import fs from "node:fs";
import path from "node:path";

export function getPlugins({ minify, outputFile }) {
  const plugins = [
    replace({
      // Ensure we don't use the dev build of React
      values: { "process.env.NODE_ENV": JSON.stringify("production") },
      preventAssignment: true,
    }),
    stripInlineSuffix(),
    importMetaAssets(),
    // https://rollupjs.org/troubleshooting/#warning-treating-module-as-external-dependency
    // TODO: We could offer a version which does not inline React/React-DOM
    nodeResolve({
      browser: true,
      preferBuiltins: false,
      // Skip deep resolution for better performance
      dedupe: ["react", "react-dom"],
    }),
    // Needed for music-metadata-browser in the Webamp bundle which depends upon
    // being able to use some polyfillable node APIs
    nodePolyfills(),
    typescript({
      compilerOptions: {
        jsx: "react-jsx",
        module: "esnext",
        declaration: false,
        declarationDir: undefined,
        outDir: "./tsBuilt",
      },
    }),
    json(),
    postcss({
      inject: false,
      plugins: [atImport, postcssOptimizeDataUriPngs],
    }),
    // Required because React still ships as CJS
    commonjs(),
    minify
      ? terser({
          compress: {
            // eslint-disable-next-line camelcase
            drop_console: true,
            // eslint-disable-next-line camelcase
            drop_debugger: true,
            // eslint-disable-next-line camelcase
            pure_funcs: ["console.log", "console.debug"],
            passes: 2,
          },
          mangle: {
            safari10: true,
          },
          format: {
            comments: false,
          },
        })
      : null,
    // Generate a report so we can see how our bundle size is spent
    visualizer({ filename: `./${outputFile}.html` }),
  ].filter(Boolean);

  return plugins;
}

// Vite expects `?inline` for CSS imports that we don't want to be auto
// injected. This hack strips that suffix here in Rollup for the library build.
function stripInlineSuffix() {
  return {
    name: "strip-inline-suffix",
    resolveId(source, importer) {
      if (source.includes("?inline")) {
        // Remove the `?inline` part from the import path
        const cleanedSource = source.replace("?inline", "");

        // Resolve the cleaned source to an absolute path
        const resolvedPath = path.resolve(
          path.dirname(importer),
          cleanedSource
        );

        return resolvedPath; // Return the absolute path
      }

      return null; // Return null to let other plugins handle the path if not modified
    },
  };
}

// Files a module finds next to itself with `new URL("./file", import.meta.url)` (walkit's
// wasm, the base skin): emitted beside the bundle, as Vite does for the demo.
function importMetaAssets() {
  const pattern = /new URL\((["'])(\.{1,2}\/[^"']+)\1,\s*import\.meta\.url\)/g;
  return {
    name: "import-meta-assets",
    transform(code, id) {
      if (!code.includes("import.meta.url")) {
        return null;
      }
      let changed = false;
      const out = code.replace(pattern, (whole, _quote, relative) => {
        const file = path.resolve(path.dirname(id), relative);
        if (!fs.existsSync(file)) {
          return whole;
        }
        const ref = this.emitFile({
          type: "asset",
          name: path.basename(file),
          source: fs.readFileSync(file),
        });
        changed = true;
        return `new URL(import.meta.ROLLUP_FILE_URL_${ref})`;
      });
      return changed ? { code: out, map: null } : null;
    },
  };
}
