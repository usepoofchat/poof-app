import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Shared flat config. Each package has a 3-line eslint.config.js that spreads this.
 * `tsconfigRootDir` must be the package's own directory (pass import.meta.dirname).
 */
export function createConfig({ tsconfigRootDir, ignores = [] }) {
  return tseslint.config(
    { ignores: ["dist/**", ".wrangler/**", "worker-configuration.d.ts", ...ignores] },
    js.configs.recommended,
    ...tseslint.configs.recommendedTypeChecked,
    {
      languageOptions: {
        parserOptions: {
          projectService: true,
          tsconfigRootDir,
        },
      },
      rules: {
        // Every promise must be awaited, returned, or explicitly voided.
        "@typescript-eslint/no-floating-promises": "error",
        "@typescript-eslint/consistent-type-imports": "error",
        "@typescript-eslint/no-unused-vars": [
          "error",
          { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
        ],
        // Security-sensitive code: never use Math.random.
        "no-restricted-properties": [
          "error",
          {
            object: "Math",
            property: "random",
            message: "Use crypto.getRandomValues for anything security-relevant.",
          },
        ],
      },
    },
    {
      // Tests assert on untyped JSON bodies and use tiny async mocks; strictness there adds noise.
      files: ["**/test/**", "**/*.test.ts", "**/*.test.tsx"],
      rules: {
        "@typescript-eslint/no-unsafe-assignment": "off",
        "@typescript-eslint/no-unsafe-member-access": "off",
        "@typescript-eslint/no-unsafe-argument": "off",
        "@typescript-eslint/no-unnecessary-type-assertion": "off",
        "@typescript-eslint/require-await": "off",
      },
    },
    {
      files: ["**/*.js", "**/*.mjs"],
      ...tseslint.configs.disableTypeChecked,
    },
  );
}
