import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 16891,
    proxy: {
      "/api": "http://localhost:16890",
      "/v1": "http://localhost:16890",
    },
  },
  build: {
    outDir: "dist",
  },
});
