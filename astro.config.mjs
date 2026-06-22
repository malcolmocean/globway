import { defineConfig } from 'astro/config';

// Default assumes a CUSTOM DOMAIN served at the root (base '/') — this avoids the
// GitHub Pages `/<repo>` base-path headaches. If you instead serve from
// https://<user>.github.io/<repo>/, set PUBLIC_BASE_PATH=/<repo> (and SITE).
// All internal links use import.meta.env.BASE_URL, so either setup works.
const SITE = process.env.PUBLIC_SITE_URL || 'https://meditation.oceanstem.com';
const BASE = process.env.PUBLIC_BASE_PATH || '/';

export default defineConfig({
  site: SITE,
  base: BASE,
  trailingSlash: 'ignore',
  build: { format: 'directory' },
});
