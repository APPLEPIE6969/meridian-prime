import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/ban-ts-comment": "off",
      "react-hooks/exhaustive-deps": "off",
      "react-hooks/purity": "off",
      // The desk pages kick off async polling loads from effects; the loads
      // setState only after an await, but the rule flags the call pattern.
      "react-hooks/set-state-in-effect": "off",
      "react/no-unescaped-entities": "off",
      "react-compiler/react-compiler": "off",
      "@next/next/no-img-element": "off",
      "no-console": "off",
      "no-empty": "off",
      "prefer-const": "off",
    },
  },
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "coverage/**",
      "dist/**",
      "next-env.d.ts",
      "mini-services/**",
    ],
  },
];

export default eslintConfig;
