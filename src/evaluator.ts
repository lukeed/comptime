import { builtinModules } from "node:module";
import { Buffer } from "node:buffer";
import { rolldown } from "rolldown";
import type { InputOptions } from "rolldown";
import type { ComptimeCore, Evaluator } from "./shared";

let evaluationCounter = 0;

export type BundleEvaluatorOptions = {
  core: Pick<ComptimeCore, "resolveId" | "load">;
  cwd?: string;
};

export class BundleEvaluator implements Evaluator {
  private readonly core: Pick<ComptimeCore, "resolveId" | "load">;
  private readonly cwd: string | undefined;

  constructor(options: BundleEvaluatorOptions) {
    this.core = options.core;
    this.cwd = options.cwd;
  }

  async evaluate(virtualId: string): Promise<unknown> {
    let input: InputOptions = {
      external(id) {
        return isBuiltin(id);
      },
      input: virtualId,
      platform: "node",
      plugins: [
        {
          name: "comptime-evaluator-virtual-modules",
          resolveId: (id) => this.core.resolveId(id),
          load: (id) => this.core.load(id),
        },
      ],
    };
    if (this.cwd !== undefined) {
      input.cwd = this.cwd;
    }

    let bundle = await rolldown(input);

    try {
      let generated = await bundle.generate({
        codeSplitting: false,
        format: "esm",
      });
      let code = firstChunkCode(generated.output);
      let url = createDataUrl(code);
      let module = await import(url);
      return readDefaultExport(module);
    } finally {
      await bundle.close();
    }
  }

  async dispose(): Promise<void> {}
}

export function readDefaultExport(module: unknown): unknown {
  if (!isRecord(module) || !("default" in module)) {
    throw new Error("comptime virtual module did not export a default value");
  }
  return module.default;
}

function firstChunkCode(output: unknown[]): string {
  for (let item of output) {
    if (isRecord(item) && item.type === "chunk" && typeof item.code === "string") {
      return item.code;
    }
  }
  throw new Error("comptime evaluator did not produce a JavaScript chunk");
}

function createDataUrl(code: string): string {
  evaluationCounter += 1;
  let encoded = Buffer.from(`${code}\n// comptime evaluation ${evaluationCounter}\n`).toString(
    "base64",
  );
  return `data:text/javascript;base64,${encoded}`;
}

function isBuiltin(id: string): boolean {
  let name = id.startsWith("node:") ? id.slice(5) : id;
  return builtinModules.includes(name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
