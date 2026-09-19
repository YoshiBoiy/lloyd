import tseslint from "typescript-eslint";
export default tseslint.config(
  { ignores: ["dist/**", "apps/web/**", "**/.venv/**"] },
  ...tseslint.configs.recommended,
);
