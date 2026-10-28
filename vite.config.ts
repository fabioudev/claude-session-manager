import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const daemon = process.env.CSM_DEV_URL ?? 'http://127.0.0.1:4747'

export default defineConfig({
  root: 'web',
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
  server: {
    port: Number(process.env.CSM_WEB_PORT ?? 5173),
    strictPort: true,
    proxy: {
      '/api': { target: daemon, changeOrigin: true },
    },
  },
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
})
