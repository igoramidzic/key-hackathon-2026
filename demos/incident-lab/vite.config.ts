import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { fileURLToPath } from 'node:url';
export default defineConfig(({ mode }) => ({
  plugins: mode === 'cloud' ? [cloudflare()] : [],
  root: fileURLToPath(new URL(mode === 'cloud' ? './' : './public', import.meta.url)),
  publicDir: false,
  server: {
    host: '127.0.0.1',
    port: 4310,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:4311', changeOrigin: false } },
  },
  build: { outDir: '../dist/client', emptyOutDir: true, target: 'es2022' },
}));
