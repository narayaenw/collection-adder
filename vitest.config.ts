import { defineConfig } from "vitest/config";

// Kept separate from vite.config.ts so tests don't load the React Router plugin.
export default defineConfig({
  test: { include: ["app/**/*.test.ts"] },
});
