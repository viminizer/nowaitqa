import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The server serves the build at /dashboard/. In dev, Vite sends the API calls to the local server.
export default defineConfig({
  base: '/dashboard/',
  plugins: [react()],
  server: { proxy: { '/dashboard/api': 'http://localhost:3000' } },
})
