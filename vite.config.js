import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages serves the site from /<repo>/, so the deploy workflow sets VITE_BASE.
export default defineConfig({
  base: process.env.VITE_BASE || '/',
  plugins: [react()],
  server: { port: 5173, open: true },
});
