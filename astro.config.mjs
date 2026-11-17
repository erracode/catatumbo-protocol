import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// Static site: deploys to Cloudflare Pages / Netlify / Vercel with zero config.
export default defineConfig({
  output: 'static',
  vite: {
    plugins: [tailwindcss()],
    // Phaser ships as ESM; let Vite pre-bundle it for the island.
    optimizeDeps: { include: ['phaser', 'playroomkit'] },
  },
});
