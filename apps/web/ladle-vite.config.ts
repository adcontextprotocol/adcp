import path from "node:path";

import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

/*
 * Ladle injects @vitejs/plugin-react itself. We deliberately omit the TanStack
 * Router plugin here because it scans for file-based routes in src/routes which
 * is irrelevant inside Ladle and breaks its config resolution.
 */
export default defineConfig({
  plugins: [tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
