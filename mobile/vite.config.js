import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// The app's screens are plain files inside the phone (Capacitor): relative paths.
export default defineConfig({
  plugins: [react()],
  base: './',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: { outDir: 'dist', target: 'es2020', chunkSizeWarningLimit: 900 },
  server: { port: 5175, host: true },
  preview: { port: 5175, host: true },
});
