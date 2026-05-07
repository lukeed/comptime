import { defineConfig } from "vite";
import { comptime } from "comptime/vite";

export default defineConfig({
  build: {
    outDir: "dist/vite",
    minify: false,
  },
  plugins: [comptime({ env: ["COMPTIME_CHANNEL"] })],
});
