import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// IMPORTANT: GitHub Pages serves a project repo at
// https://<username>.github.io/<repo-name>/ — Vite needs to know that path
// prefix at build time so its generated <script>/<link> tags point to the
// right place. Change "brainsorter" below to match whatever you name the
// GitHub repo. (If you deploy this as a user/org page — a repo literally
// named "<username>.github.io" — set base back to "/" instead.)
export default defineConfig({
  plugins: [react()],
  base: "/Brainsorter/",
});
