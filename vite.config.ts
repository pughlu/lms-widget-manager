/// <reference types="vitest" />
import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'LMSWidgetManager',
      formats: ['iife', 'es', 'cjs'],
      fileName: (format) => `lms-widget-manager.${format}.js`
    },
    sourcemap: true,
    rollupOptions: {
      output: {
        extend: true
      }
    }
  },
  test: {
    environment: 'jsdom',
    globals: true
  }
});
