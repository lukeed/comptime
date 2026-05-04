import { describe, expect, test } from "bun:test";
import { ComptimeTransformError, createCore } from "./shared";
import type { Evaluator } from "./shared";

function createEvaluator(value: unknown, bodies: string[]): Evaluator {
  return {
    async evaluate(_virtualId, body) {
      bodies.push(body);
      return value;
    },
    async dispose() { },
  };
}

describe("shared transform core", () => {
  test("replaces imported comptime calls with serialized values", async () => {
    let bodies: string[] = [];
    let evaluator = createEvaluator(3, bodies);
    let core = createCore({ getEvaluator: () => evaluator });
    let result = await core.transform(
      'import { comptime } from "comptime";\nlet value = comptime(() => 1 + 2);\n',
      "/project/src/app.ts",
    );

    expect(result?.code).toContain("let value = 3;");
    expect(result?.map).toBeTruthy();
    expect(bodies[ 0 ]).toContain("return 1 + 2;");
  });

  test("ignores comptime identifiers that are not imported from the package", async () => {
    let bodies: string[] = [];
    let evaluator = createEvaluator(1, bodies);
    let core = createCore({ getEvaluator: () => evaluator });
    let result = await core.transform(
      "let comptime = (fn: () => number) => fn();\nlet value = comptime(() => 2);\n",
      "/project/src/app.ts",
    );

    expect(result).toBeNull();
    expect(bodies).toHaveLength(0);
  });

  test("supports aliased imports and does not transform a shadowed binding", async () => {
    let bodies: string[] = [];
    let evaluator = createEvaluator(8, bodies);
    let core = createCore({ getEvaluator: () => evaluator });
    let result = await core.transform(
      [
        'import { comptime as ct } from "comptime";',
        "function demo(ct: (fn: () => number) => number) {",
        "  return ct(() => 1);",
        "}",
        "let value = ct(() => 4 + 4);",
      ].join("\n"),
      "/project/src/app.ts",
    );

    expect(result?.code).toContain("return ct(() => 1);");
    expect(result?.code).toContain("let value = 8;");
    expect(bodies).toHaveLength(1);
  });

  test("captures referenced imports as absolute imports in virtual modules", async () => {
    let bodies: string[] = [];
    let evaluator = createEvaluator(55, bodies);
    let core = createCore({ getEvaluator: () => evaluator });
    await core.transform(
      [
        'import { comptime } from "comptime";',
        'import { fib } from "./math";',
        'import { unused } from "./unused";',
        "let value = comptime(() => fib(10));",
      ].join("\n"),
      "/project/src/app.ts",
    );

    expect(bodies[ 0 ]).toContain('import { fib } from "/project/src/math";');
    expect(bodies[ 0 ]).not.toContain("unused");
  });

  test("includes top-level declarations used by the comptime body", async () => {
    let bodies: string[] = [];
    let evaluator = createEvaluator(12, bodies);
    let core = createCore({ getEvaluator: () => evaluator });
    await core.transform(
      [
        'import { comptime } from "comptime";',
        "let factor = 3;",
        "function mul(value: number) { return value * factor; }",
        "let result = comptime(() => mul(4));",
      ].join("\n"),
      "/project/src/app.ts",
    );

    expect(bodies[ 0 ]).toContain("let factor = 3;");
    expect(bodies[ 0 ]).toContain("function mul(value: number)");
  });

  test("reports invalid call shapes at the original location", async () => {
    let evaluator = createEvaluator(0, []);
    let core = createCore({ getEvaluator: () => evaluator });
    let thrown: unknown;

    try {
      await core.transform(
        'import { comptime } from "comptime";\nlet value = comptime(1);\n',
        "/project/src/app.ts",
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ComptimeTransformError);
    if (thrown instanceof ComptimeTransformError) {
      expect(thrown.message).toBe(
        "comptime() requires a single arrow function with no parameters",
      );
      expect(thrown.loc.line).toBe(2);
      expect(thrown.loc.column).toBe(12);
    }
  });

  test("wraps serialization failures with the call site", async () => {
    let evaluator = createEvaluator(() => 1, []);
    let core = createCore({ getEvaluator: () => evaluator });
    let thrown: unknown;

    try {
      await core.transform(
        'import { comptime } from "comptime";\nlet value = comptime(() => () => 1);\n',
        "/project/src/app.ts",
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ComptimeTransformError);
    if (thrown instanceof ComptimeTransformError) {
      expect(thrown.message).toContain(
        "comptime returned a value that cannot be serialized",
      );
      expect(thrown.id).toBe("/project/src/app.ts");
    }
  });

  test("times out slow evaluations", async () => {
    let evaluator: Evaluator = {
      async evaluate() {
        return await new Promise(() => { });
      },
      async dispose() { },
    };
    let core = createCore({
      getEvaluator: () => evaluator,
      options: { timeoutMs: 1 },
    });
    let thrown: unknown;

    try {
      await core.transform(
        'import { comptime } from "comptime";\nlet value = comptime(() => 1);\n',
        "/project/src/app.ts",
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ComptimeTransformError);
    if (thrown instanceof ComptimeTransformError) {
      expect(thrown.message).toBe("comptime evaluation timed out after 1ms");
    }
  });

  test("includes statically read env values in the cache key", async () => {
    let count = 0;
    let evaluator: Evaluator = {
      async evaluate() {
        count += 1;
        return count;
      },
      async dispose() { },
    };
    let core = createCore({ getEvaluator: () => evaluator });
    let code =
      'import { comptime } from "comptime";\nlet value = comptime(() => process.env.BUILD_ID);\n';
    process.env.BUILD_ID = "one";
    let first = await core.transform(code, "/project/src/app.ts");
    let second = await core.transform(code, "/project/src/app.ts");
    process.env.BUILD_ID = "two";
    let third = await core.transform(code, "/project/src/app.ts");

    expect(first?.code).toContain("1");
    expect(second?.code).toContain("1");
    expect(third?.code).toContain("2");
    delete process.env.BUILD_ID;
  });
});
