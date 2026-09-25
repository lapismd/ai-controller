import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/**/*.test.ts",
      "scripts/**/*.test.mjs",
      "scripts/architecture.test.mjs",
    ],
    exclude: ["scripts/architecture-fixtures/**"],
  },
});
