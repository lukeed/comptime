import { builtinModules, createRequire } from "node:module";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import { access, readFile } from "node:fs/promises";
import { moduleRunnerTransform } from "rolldown/experimental";
import { transform } from "rolldown/utils";
import { ESModulesEvaluator, ModuleRunner } from "vite/module-runner";
import type { ComptimeCore, Evaluator } from "./shared";

const RESOLUTION_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

export type ModuleRunnerEvaluatorOptions = {
  core: Pick<ComptimeCore, "resolveId" | "load">;
  cwd?: string;
};

export type EvaluatorHost = {
  resolve(id: string, importer: string | undefined): Promise<HostResolved | null>;
  load(id: string): Promise<string | null>;
};

export type HostResolved = {
  id: string;
  external: boolean;
};

type FetchModuleOptions = {
  cached?: boolean;
  startOffset?: number;
};

type FetchModuleResult =
  | { cache: true }
  | { externalize: string; type: "module" | "commonjs" | "builtin" | "network" }
  | {
      code: string;
      file: string | null;
      id: string;
      url: string;
      invalidate: boolean;
    };

type InvokeRequest = {
  name: string;
  data: unknown[];
};

type InvokeResult = { result: unknown } | { error: SerializableError };

type SerializableError = {
  message: string;
  name?: string;
  stack?: string;
};

type LoadedModule = {
  id: string;
  code: string;
};

export class ModuleRunnerEvaluator implements Evaluator {
  readonly #core: Pick<ComptimeCore, "resolveId" | "load">;
  readonly #cwd: string;
  readonly #runner: ModuleRunner;
  #host: EvaluatorHost | undefined;

  constructor(options: ModuleRunnerEvaluatorOptions) {
    this.#core = options.core;
    this.#cwd = options.cwd ?? process.cwd();
    this.#runner = new ModuleRunner(
      {
        hmr: false,
        sourcemapInterceptor: "prepareStackTrace",
        transport: {
          invoke: async (payload: unknown): Promise<InvokeResult> => {
            try {
              return { result: await this.#handleInvoke(payload) };
            } catch (error) {
              return { error: serializeError(error) };
            }
          },
        },
      },
      new ESModulesEvaluator(),
    );
  }

  setHost(host: EvaluatorHost | undefined): void {
    this.#host = host;
  }

  async evaluate(virtualId: string): Promise<unknown> {
    let module = await this.#runner.import(virtualId);
    return readDefaultExport(module);
  }

  async dispose(): Promise<void> {
    if (!this.#runner.isClosed()) {
      await this.#runner.close();
    }
  }

  async #handleInvoke(payload: unknown): Promise<unknown> {
    let request = parseInvokeRequest(payload);
    if (request.name === "getBuiltins") {
      return builtinIds();
    }
    if (request.name === "fetchModule") {
      return await this.#fetchModule(request.data);
    }
    throw new Error(`Unsupported ModuleRunner invoke: ${request.name}`);
  }

  async #fetchModule(args: unknown[]): Promise<FetchModuleResult> {
    let id = typeof args[0] === "string" ? args[0] : undefined;
    let importer = typeof args[1] === "string" ? args[1] : undefined;
    let options = isRecord(args[2]) ? readFetchModuleOptions(args[2]) : {};

    if (id === undefined) {
      throw new Error("ModuleRunner fetchModule expected a string id");
    }
    if (options.cached) {
      return { cache: true };
    }
    if (isBuiltin(id)) {
      return { externalize: id, type: "builtin" };
    }

    let hostResolved = await this.#host?.resolve(id, importer);
    if (hostResolved) {
      if (hostResolved.external) {
        return {
          externalize: resolveExternal(hostResolved.id, importer, this.#cwd),
          type: "module",
        };
      }
      let loaded = await this.#loadResolvedModule(hostResolved.id);
      return await this.#transformLoadedModule(loaded);
    }

    if (isBareSpecifier(id)) {
      return { externalize: resolveExternal(id, importer, this.#cwd), type: "module" };
    }

    let loaded = await this.#loadModule(id, importer);
    return await this.#transformLoadedModule(loaded);
  }

  async #transformLoadedModule(loaded: LoadedModule): Promise<FetchModuleResult> {
    let transformed = await transformForModuleRunner(loaded.id, loaded.code, this.#cwd);

    return {
      code: transformed,
      file: loaded.id.startsWith("\0") ? null : loaded.id,
      id: loaded.id,
      url: loaded.id,
      invalidate: true,
    };
  }

  async #loadModule(id: string, importer: string | undefined): Promise<LoadedModule> {
    let virtualId = this.#core.resolveId(id);
    if (virtualId) {
      let code = this.#core.load(virtualId);
      if (code !== null) {
        return { id: virtualId, code };
      }
    }

    let resolved = await this.#resolveModule(id, importer);
    return await this.#loadResolvedModule(resolved);
  }

  async #loadResolvedModule(resolved: string): Promise<LoadedModule> {
    let virtualResolved = this.#core.resolveId(resolved);
    if (virtualResolved) {
      let code = this.#core.load(virtualResolved);
      if (code !== null) {
        return { id: virtualResolved, code };
      }
    }

    let hostCode = await this.#host?.load(resolved);
    if (hostCode !== undefined && hostCode !== null) {
      return { id: resolved, code: hostCode };
    }

    return { id: resolved, code: await readFile(resolved, "utf8") };
  }

  async #resolveModule(id: string, importer: string | undefined): Promise<string> {
    if (id.startsWith("file:")) {
      return new URL(id).pathname;
    }

    let base = importer && !importer.startsWith("\0") ? dirname(importer) : this.#cwd;
    let candidate = isAbsolute(id) ? id : resolve(base, id);
    return await resolveExistingPath(candidate);
  }
}

export function readDefaultExport(module: unknown): unknown {
  if (!isRecord(module) || !("default" in module)) {
    throw new Error("comptime virtual module did not export a default value");
  }
  return module.default;
}

async function transformForModuleRunner(id: string, source: string, cwd: string): Promise<string> {
  let filename = id.startsWith("\0") ? resolve(cwd, `${sanitizeVirtualId(id)}.ts`) : id;
  let stripped = await transform(filename, source, {
    cwd,
    lang: inferLang(filename),
    sourceType: "module",
    sourcemap: true,
  });
  if (stripped.errors.length > 0) {
    throw stripped.errors[0] ?? new Error("Rolldown transform failed");
  }

  let transformed = await moduleRunnerTransform(filename, stripped.code, {
    sourcemap: true,
  });
  if (transformed.errors.length > 0) {
    throw transformed.errors[0] ?? new Error("Rolldown moduleRunnerTransform failed");
  }
  return transformed.code;
}

function parseInvokeRequest(payload: unknown): InvokeRequest {
  if (!isRecord(payload)) {
    throw new Error("ModuleRunner invoke payload must be an object");
  }
  let data = payload.data;
  if (!isRecord(data)) {
    throw new Error("ModuleRunner invoke payload is missing data");
  }
  let name = data.name;
  if (typeof name !== "string") {
    throw new Error("ModuleRunner invoke payload is missing a name");
  }
  let args = data.data;
  return { name, data: Array.isArray(args) ? args : [] };
}

function readFetchModuleOptions(value: Record<string, unknown>): FetchModuleOptions {
  let options: FetchModuleOptions = { cached: value.cached === true };
  if (typeof value.startOffset === "number") {
    options.startOffset = value.startOffset;
  }
  return options;
}

async function resolveExistingPath(path: string): Promise<string> {
  if (await exists(path)) {
    return path;
  }

  if (extname(path) === "") {
    for (let extension of RESOLUTION_EXTENSIONS) {
      let candidate = `${path}${extension}`;
      if (await exists(candidate)) {
        return candidate;
      }
    }
    for (let extension of RESOLUTION_EXTENSIONS) {
      let candidate = resolve(path, `index${extension}`);
      if (await exists(candidate)) {
        return candidate;
      }
    }
  }

  throw new Error(`comptime body imports '${path}' which could not be resolved`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function resolveExternal(id: string, importer: string | undefined, cwd: string): string {
  if (id.startsWith("file:") || isAbsolute(id)) {
    return id;
  }
  if (!isBareSpecifier(id)) {
    return id;
  }
  let base = importer && !importer.startsWith("\0") ? dirname(importer) : cwd;
  return createRequire(resolve(base, "comptime-evaluator.js")).resolve(id);
}

function inferLang(id: string): "js" | "jsx" | "ts" | "tsx" {
  let extension = extname(id);
  if (extension === ".tsx") {
    return "tsx";
  }
  if (extension === ".jsx") {
    return "jsx";
  }
  if (extension === ".ts" || extension === ".mts" || extension === ".cts") {
    return "ts";
  }
  return "js";
}

function sanitizeVirtualId(id: string): string {
  return id.replaceAll(/[^A-Za-z0-9_]+/g, "_");
}

function isBareSpecifier(id: string): boolean {
  return (
    !id.startsWith("\0") && !id.startsWith(".") && !id.startsWith("/") && !id.startsWith("file:")
  );
}

function isBuiltin(id: string): boolean {
  let name = id.startsWith("node:") ? id.slice(5) : id;
  return builtinModules.includes(name);
}

function builtinIds(): string[] {
  let ids: string[] = [];
  for (let module of builtinModules) {
    ids.push(module);
    ids.push(`node:${module}`);
  }
  return ids;
}

function serializeError(error: unknown): SerializableError {
  if (error instanceof Error) {
    let serialized: SerializableError = {
      message: error.message,
      name: error.name,
    };
    if (error.stack !== undefined) {
      serialized.stack = error.stack;
    }
    return serialized;
  }
  return { message: String(error) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
