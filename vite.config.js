import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom')) return 'react'
          if (id.includes('node_modules/@tauri-apps')) return 'tauri'
          if (id.includes('node_modules/qrcode')) return 'qrcode'
          if (id.includes('node_modules')) return 'vendor'
          return undefined
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
})
