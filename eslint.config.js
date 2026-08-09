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
      // Both were warnings under a ratchet while the backlog was worked down.
      // The backlog is gone, so they are errors: a ratchet at zero and an
      // error are the same gate, and the error says so at the point of writing
      // rather than at CI time.
      //
      // Clearing them was not cosmetic. The `any`s were hiding a Solana key
      // being called hex, a Velar decimals field being a string that only
      // worked through JS coercion, and a Stacks transaction that could be
      // null at broadcast. Each surfaced the moment a real type went in.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-console": "error",
    },
  },
  {
    // Integration suites are run by hand against a live testnet and print
    // progress as they go — an operator watching a funded wallet move real
    // value needs to see each step as it happens, which is exactly what the
    // structured logger is not for. Everywhere else, console output is a
    // caller who should be using the logger.
    files: ["tests/integration/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },
  {
    ignores: ["dist/**", "node_modules/**", "web/**"],
  },
];
