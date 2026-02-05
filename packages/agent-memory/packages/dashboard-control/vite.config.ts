import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 9447,
    proxy: {
      '/control-plane': {
        target: 'http://localhost:9445',
        changeOrigin: true,
      },
    },
  },
});
