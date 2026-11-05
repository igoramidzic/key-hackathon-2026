import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: fileURLToPath(new URL('./public', import.meta.url)),
  server: {
    host: '127.0.0.1',
    port: 4310,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:4311', changeOrigin: false } },
  },
  build: { outDir: '../dist/client', emptyOutDir: true, target: 'es2022' },
});
