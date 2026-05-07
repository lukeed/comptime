import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { rolldown } from "rolldown";
import { build, createServer } from "vite";
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

  test("vite dev reevaluates changed virtual modules", async () => {
    let root = createFixture("vite-dev");
    let entry = writeVariableFixture(root, 12);
    let server = await createServer({
      root,
      appType: "custom",
      logLevel: "silent",
      plugins: [viteComptime()],
      server: {
        middlewareMode: true,
      },
    });

    try {
      let first = await server.transformRequest("/src/app.ts");
      expect(first?.code).toContain("let input = 12;");
      expect(first?.code).toContain("let value = 144;");

      writeVariableFixture(root, 10);
      server.moduleGraph.onFileChange(entry);

      let second = await server.transformRequest("/src/app.ts");
      expect(second?.code).toContain("let input = 10;");
      expect(second?.code).toContain("let value = 55;");
      expect(second?.code).not.toContain("let value = 144;");
    } finally {
      await server.close();
    }
  });

  test("vite dev evaluates async comptime bodies", async () => {
    let root = createFixture("vite-dev-async");
    writeAsyncFixture(root);
    let server = await createServer({
      root,
      appType: "custom",
      logLevel: "silent",
      plugins: [viteComptime()],
      server: {
        middlewareMode: true,
      },
    });

    try {
      let result = await server.transformRequest("/src/app.ts");
      expect(result?.code).toContain("let value = 55;");
    } finally {
      await server.close();
    }
  });

  test("vite dev strips TypeScript in comptime bodies", async () => {
    let root = createFixture("vite-dev-typescript-body");
    writeTypedAsyncFixture(root);
    let server = await createServer({
      root,
      appType: "custom",
      logLevel: "silent",
      plugins: [viteComptime()],
      server: {
        middlewareMode: true,
      },
    });

    try {
      let result = await server.transformRequest("/src/app.ts");
      expect(result?.code).toContain('let value = "ok";');
    } finally {
      await server.close();
    }
  });

  test("rolldown build resolves dynamic bare imports from the project", async () => {
    let root = createFixture("rolldown-dynamic-import");
    let entry = writeDynamicImportFixture(root);
    let bundle = await rolldown({
      cwd: root,
      input: entry,
      plugins: [rolldownComptime()],
    });
    let output = await bundle.generate({ format: "esm" });
    await bundle.close();
    let code = output.output.map((chunk) => (chunk.type === "chunk" ? chunk.code : "")).join("\n");

    expect(code).toContain("55");
    expect(code).not.toContain("dynamic-comptime-value");
  });

  test("vite build resolves dynamic bare imports from the project", async () => {
    let root = createFixture("vite-dynamic-import");
    let entry = writeDynamicImportFixture(root);
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
    expect(code).not.toContain("dynamic-comptime-value");
  });
});

function createFixture(name: string): string {
  let root = realpathSync(mkdtempSync(resolve(tmpdir(), `comptime-${name}-`)));
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

function writeVariableFixture(root: string, input: number): string {
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
      `let input = ${input};`,
      "let value = comptime(() => fib(input));",
      "export let message = `fibonacci(${input}) = ${value}`;",
    ].join("\n"),
  );
  return entry;
}

function writeDynamicImportFixture(root: string): string {
  let entry = resolve(root, "src/app.ts");
  let packageRoot = resolve(root, "node_modules/dynamic-comptime-value");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    resolve(packageRoot, "package.json"),
    JSON.stringify({
      name: "dynamic-comptime-value",
      version: "1.0.0",
      type: "module",
      exports: "./index.js",
    }),
  );
  writeFileSync(resolve(packageRoot, "index.js"), "export let value = 55;\n");
  writeFileSync(
    entry,
    [
      'import { comptime } from "comptime";',
      "export let value = comptime(async () => {",
      '  let mod = await import("dynamic-comptime-value");',
      "  return mod.value;",
      "});",
    ].join("\n"),
  );
  return entry;
}

function writeAsyncFixture(root: string): string {
  let entry = resolve(root, "src/app.ts");
  writeFileSync(
    entry,
    [
      'import { comptime } from "comptime";',
      "export let value = comptime(async () => {",
      "  return 55;",
      "});",
    ].join("\n"),
  );
  return entry;
}

function writeTypedAsyncFixture(root: string): string {
  let entry = resolve(root, "src/app.ts");
  writeFileSync(
    entry,
    [
      'import { comptime } from "comptime";',
      "type Payload = { value: string };",
      "export let value = comptime(async () => {",
      '  let payload: Payload = { value: "ok" };',
      "  return payload.value;",
      "});",
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
