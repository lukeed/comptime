import { defineConfig } from "rolldown";
import { comptime } from "comptime/rolldown";

export default defineConfig({
  input: "src/main.ts",
  output: {
    dir: "dist/rolldown",
    entryFileNames: "main.js",
    format: "esm",
  },
  platform: "browser",
  plugins: [
    comptime({
      serializers: [
        {
          test(value) {
            return value instanceof URL;
          },
          serialize(value) {
            if (value instanceof URL) {
              return `new URL(${JSON.stringify(value.href)})`;
            }
            throw new Error("Expected URL");
          },
        },
      ],
    }),
  ],
});
