import { defineConfig } from 'vitest/config';
export default defineConfig({test:{include:['tests/**/*.test.ts','tests/**/*.test.tsx'],environment:'jsdom',setupFiles:['./tests/setup.ts']}});
