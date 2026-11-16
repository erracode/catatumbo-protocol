import { defineConfig } from 'astro/config';

// Static site: deploys to Cloudflare Pages / Netlify / Vercel with zero config.
export default defineConfig({
  output: 'static',
  vite: {
    // Phaser ships as ESM; let Vite pre-bundle it for the island.
    optimizeDeps: { include: ['phaser', 'playroomkit'] },
  },
});
