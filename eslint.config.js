import reactHooks from "eslint-plugin-react-hooks";
import { createConfig } from "@poof/tooling/eslint";

// The web app at the workspace root. Packages lint themselves with their own configs.
export default [
  ...createConfig({
    tsconfigRootDir: import.meta.dirname,
    ignores: [
      "worker/**",
      "packages/**",
      "e2e/**",
      "tooling/**",
      "test-results/**",
      "playwright-report/**",
      "dist-engine/**",
      "release/**",
      "out/**",
    ],
  }),
  reactHooks.configs.flat.recommended,
];
