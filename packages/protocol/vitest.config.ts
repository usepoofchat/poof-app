import { defineConfig } from "vitest/config";

// Own config so vitest doesn't pick up the web app's (jsdom) config from the workspace root.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
