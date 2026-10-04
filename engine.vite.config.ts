import { defineConfig } from "vite";

// The client engine (packages/core) as one self-contained ES module, for a web app without a build
// step: `import { RoomSession, createRoom, … } from "./poof-engine.js"`. Not minified, so what the
// site ships can be read and diffed against this repository.
export default defineConfig({
  publicDir: false,
  build: {
    lib: {
      entry: "packages/core/src/index.ts",
      formats: ["es"],
      fileName: () => "poof-engine.js",
    },
    outDir: "dist-engine",
    emptyOutDir: true,
    minify: false,
    target: "es2022",
    reportCompressedSize: false,
  },
});
