import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { rolldown } from "rolldown";
import { build } from "vite";
import { comptime as rolldownComptime } from "./rolldown";
import { comptime as viteComptime } from "./vite";

describe("plugin adapters", () => {
  test("evaluator uses rolldown module runner transform", () => {
    let source = readFileSync(resolve(import.meta.dir, "evaluator.ts"), "utf8");

    expect(source).toContain('from "rolldown/experimental"');
    expect(source).toContain("moduleRunnerTransform");
    expect(source).toContain("ModuleRunner");
  });

  test("rolldown build replaces comptime calls", async () => {
    let root = createFixture("rolldown");
    let entry = writeFixture(root);
    let bundle = await rolldown({
      input: entry,
      plugins: [rolldownComptime()],
    });
    let output = await bundle.generate({ format: "esm" });
    await bundle.close();
    let code = output.output.map((chunk) => (chunk.type === "chunk" ? chunk.code : "")).join("\n");

    expect(code).toContain("55");
    expect(code).not.toContain("comptime(");
  });

  test("vite build replaces comptime calls", async () => {
    let root = createFixture("vite");
    let entry = writeFixture(root);
    let output = await build({
      root,
      logLevel: "silent",
      plugins: [viteComptime()],
      build: {
        emptyOutDir: false,
        lib: {
          entry,
          fileName: "app",
          formats: ["es"],
        },
        write: false,
      },
    });
    let code = collectCode(output);

    expect(code).toContain("55");
    expect(code).not.toContain("comptime(");
  });
});

function createFixture(name: string): string {
  let root = mkdtempSync(resolve(tmpdir(), `comptime-${name}-`));
  mkdirSync(resolve(root, "src"));
  return root;
}

function writeFixture(root: string): string {
  let entry = resolve(root, "src/app.ts");
  writeFileSync(
    resolve(root, "src/math.ts"),
    "export function fib(n: number): number { return n < 2 ? n : fib(n - 1) + fib(n - 2); }\n",
  );
  writeFileSync(
    entry,
    [
      'import { comptime } from "comptime";',
      'import { fib } from "./math";',
      "export let value = comptime(() => fib(10));",
    ].join("\n"),
  );
  return entry;
}

function collectCode(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((item) => collectCode(item)).join("\n");
  }
  if (!isRecord(value)) {
    return "";
  }
  let output = value.output;
  if (!Array.isArray(output)) {
    return "";
  }
  return output
    .map((chunk) => {
      if (!isRecord(chunk) || chunk.type !== "chunk" || typeof chunk.code !== "string") {
        return "";
      }
      return chunk.code;
    })
    .join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
