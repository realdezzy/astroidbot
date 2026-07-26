import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

export default [
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "./tsconfig.eslint.json",
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      // Pre-existing debt, mostly at untyped DEX-SDK boundaries. Kept as a
      // warning rather than an error so `lint` can be a hard CI gate today,
      // with scripts/lint-ratchet.mjs holding the count so it can only fall.
      // Fix these opportunistically when touching the surrounding code.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-console": "warn",
    },
  },
  {
    ignores: ["dist/**", "node_modules/**", "web/**"],
  },
];
