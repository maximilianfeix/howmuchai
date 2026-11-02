import { defineConfig } from "vite";

// Served from https://maximilianfeix.github.io/howmuchai/ until the custom domain is live.
// Set HOWMUCHAI_BASE=/ and HOWMUCHAI_SITE=https://howmuchai.dev when it is.
const base = process.env.HOWMUCHAI_BASE ?? "/howmuchai/";
const site = (process.env.HOWMUCHAI_SITE ?? "https://maximilianfeix.github.io/howmuchai").replace(/\/$/, "");

export default defineConfig({
  root: "web",
  base,
  publicDir: "public",
  define: { __SITE__: JSON.stringify(site) },
  build: { outDir: "../dist/site", emptyOutDir: true, target: "es2022" },
});
