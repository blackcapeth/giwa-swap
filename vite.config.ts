import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/giwa-swap/",
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 1200,
  },
});
