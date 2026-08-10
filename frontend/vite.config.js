import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// During local `npm run dev` the frontend proxies API + WS + music requests to
// the Go backend so everything works from a single origin.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
      '/music': { target: 'http://localhost:8080', changeOrigin: true },
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
})
