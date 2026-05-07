import { defineConfig } from "vite";
import { comptime } from "comptime/vite";

export default defineConfig({
  build: {
    outDir: "dist/vite",
    minify: false,
  },
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
