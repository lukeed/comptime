import { defineConfig } from "rolldown";
import { comptime } from "comptime/rolldown";

export default defineConfig({
  input: "src/main.tsx",
  output: {
    dir: "dist/rolldown",
    entryFileNames: "main.js",
    format: "esm",
  },
  platform: "browser",
  plugins: [comptime()],
});
