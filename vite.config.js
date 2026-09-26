import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages serves a project repo at
// https://<username>.github.io/<repo-name>/ — the base path below has to
// match the repo name EXACTLY, including capitalisation (GitHub Pages URLs
// are case-sensitive). This reuses the existing "Brainsorter" repo, so it's
// set to match that — not the new "Bonce" name — deliberately.
export default defineConfig({
  plugins: [react()],
  base: "/Brainsorter/",
});
