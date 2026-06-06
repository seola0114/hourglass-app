import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
    // three.js 단일 번들이 500kB를 넘는 것은 정상 — 경고 한계치를 올린다.
    chunkSizeWarningLimit: 1000,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
