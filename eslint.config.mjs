import tseslint from "typescript-eslint";

export default tseslint.config(
    { ignores: ["**/dist/**", "**/node_modules/**", "smart-contract/out/**"] },
    ...tseslint.configs.recommended,
);
