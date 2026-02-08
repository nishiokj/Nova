import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
          'codemirror-view': ['@codemirror/view', '@codemirror/state'],
          'codemirror-lang': [
            '@codemirror/commands',
            '@codemirror/autocomplete',
            '@codemirror/language',
            '@codemirror/lang-markdown',
          ],
        },
      },
    },
  },
  server: {
    port: 5175,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:9444',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      '/control-plane': {
        target: 'http://127.0.0.1:9445',
        changeOrigin: true,
      },
    },
  },
})
