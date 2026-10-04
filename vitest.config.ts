import { defineConfig } from "vitest/config";

// React hooks and RoomProvider tests. The workspace packages have their own vitest configs.
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
