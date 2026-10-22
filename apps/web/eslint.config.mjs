import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

const config = [
  { ignores: [".next/**", "node_modules/**", "next-env.d.ts"] },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    // Plain apostrophes/quotes in JSX text are safe (React escapes text
    // content); this rule is purely stylistic.
    rules: { "react/no-unescaped-entities": "off" },
  },
];

export default config;
