import path from "path"
import { readFileSync } from "node:fs"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const pkg = JSON.parse(
  readFileSync(path.resolve(__dirname, "package.json"), "utf-8")
) as { version: string }

// The index-n2 server the dev client proxies to. INDEX_N2_API_PORT points it
// at a server started on another port (PORT=... node server.js).
const apiTarget = `http://localhost:${process.env.INDEX_N2_API_PORT || 5787}`

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: {
      "/api": apiTarget,
      "/media": apiTarget,
      "/thumbs": apiTarget,
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
})
