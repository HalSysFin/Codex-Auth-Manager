import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: ['localhost', '127.0.0.1', 'openauth.plingindigo.org'],
    proxy: {
      '/api': 'http://auth-manager:8080',
      '/auth': 'http://auth-manager:8080',
      '/health': 'http://auth-manager:8080',
      '/internal': 'http://auth-manager:8080',
      '/ui': 'http://auth-manager:8080',
      '/login': 'http://auth-manager:8080',
      '/logout': 'http://auth-manager:8080',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
