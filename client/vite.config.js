import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
      // The installer file lives outside /api because it is a binary, not
      // JSON, so the dev server has to forward it or the button 404s here and
      // only works in production.
      //
      // Must be '/download/desktop', NOT '/download'. The site also has a
      // /download PAGE, and proxying that prefix hands the React route to
      // Express, which answers with the production index.html — whose asset
      // paths do not resolve through the dev server. The page then renders
      // completely blank with no console error, because nothing threw: the
      // browser simply loaded a different, broken document.
      '/download/desktop': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
});
