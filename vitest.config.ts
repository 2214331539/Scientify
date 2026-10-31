import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    restoreMocks: true,
    // Whole-shell UI tests take 2-6 s in jsdom; the 5 s default fails them on a busy runner.
    testTimeout: 15_000,
  },
});
