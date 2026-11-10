import { Connect, defineConfig, Plugin } from "vite";
import nodePolyfills from "rollup-plugin-polyfill-node";
import fs from "node:fs";
import path from "node:path";

// Modern skins need Winamp's wasabi base and the stand-in fonts, which are not ours to
// ship: the dev server serves them from where WALKIT_WASABI (a zip) and WALKIT_FONTS (a
// folder) point, at /walkit/wasabi.zip, /walkit/fonts.json and /walkit/fonts/<file>.
function walkitAssets(): Plugin {
  const wasabi = process.env.WALKIT_WASABI;
  const fonts = process.env.WALKIT_FONTS;
  const fontFiles = () =>
    fonts && fs.existsSync(fonts)
      ? fs.readdirSync(fonts).filter((f) => /\.ttf$/i.test(f))
      : [];
  const serve: Connect.NextHandleFunction = (req, res, next) => {
    const url = decodeURIComponent((req.url ?? "").split("?")[0]);
    const send = (file: string, type: string) => {
      res.setHeader("Content-Type", type);
      fs.createReadStream(file).pipe(res);
    };
    if (url === "/wasabi.zip" && wasabi && fs.existsSync(wasabi)) {
      return send(wasabi, "application/zip");
    }
    if (url === "/fonts.json") {
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify(fontFiles()));
    }
    const font = url.match(/^\/fonts\/([^/]+)$/)?.[1];
    if (fonts && font && fontFiles().includes(font)) {
      return send(path.join(fonts, font), "font/ttf");
    }
    next();
  };
  return {
    name: "walkit-assets",
    configureServer(server) {
      server.middlewares.use("/walkit", serve);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/walkit", serve);
    },
  };
}

export default defineConfig({
  build: {
    outDir: "dist",
    chunkSizeWarningLimit: 2500,
  },
  assetsInclude: ["**/*.wsz", "**/*.mp3", "**/*.wasm"],
  plugins: [
    walkitAssets(),
    // Needed for music-metadata-browser which uses polyfillable node APIs
    // @ts-expect-error Rollup plugin type mismatch with Vite's stricter types
    nodePolyfills(),
  ],
});
