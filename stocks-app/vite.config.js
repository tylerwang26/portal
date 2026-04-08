import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  base: '/stocks/',
  root: path.resolve(__dirname),
  build: {
    outDir: path.resolve(__dirname, '../stocks-dist'),
    emptyOutDir: true,
  },
});
