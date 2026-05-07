import { createCore, includeEvaluationCauseStack, toDevID } from "./shared";
import { ModuleRunnerEvaluator, readDefaultExport } from "./evaluator";

import type { Plugin, ViteDevServer } from "vite";
import type { Options, Evaluator } from "./shared";
import type { EvaluatorHost } from "./evaluator";

export type { Serializer } from "./shared";

type ViteEvaluatorOptions = {
  fallback: ModuleRunnerEvaluator;
  getServer(): ViteDevServer | undefined;
};

class ViteEvaluator implements Evaluator {
  readonly #fallback: ModuleRunnerEvaluator;
  readonly #getServer: () => ViteDevServer | undefined;

  constructor(options: ViteEvaluatorOptions) {
    this.#fallback = options.fallback;
    this.#getServer = options.getServer;
  }

  async evaluate(virtualId: string, origin: string): Promise<unknown> {
    let server = this.#getServer();
    if (server) {
      invalidateVirtualModule(server, virtualId);
      let viteVirtualId = toDevID(origin, virtualId);
      // Vite dev loads the source-file alias so its normal TS/TSX transform runs; build fallback
      // keeps using the internal \0 id that the module runner can import directly.
      invalidateVirtualModule(server, viteVirtualId);
      try {
        return readDefaultExport(
          await server.ssrLoadModule(viteVirtualId, { fixStacktrace: true }),
        );
      } catch (error) {
        includeEvaluationCauseStack(error);
        throw error;
      }
    }
    return await this.#fallback.evaluate(virtualId);
  }

  setHost(host: EvaluatorHost | undefined): void {
    this.#fallback.setHost(host);
  }

  dispose(): Promise<void> {
    return this.#fallback.dispose();
  }
}

export function comptime(options?: Options): Plugin {
  let server: ViteDevServer | undefined;
  let evaluator: ViteEvaluator | undefined;
  let core = createCore({ getEvaluator, options });

  function getEvaluator(): Evaluator {
    if (evaluator) return evaluator;
    throw new Error("comptime evaluator was used before configResolved");
  }

  return {
    name: "comptime",
    enforce: "pre",
    configResolved(config) {
      evaluator = new ViteEvaluator({
        fallback: new ModuleRunnerEvaluator({ core, cwd: config.root }),
        getServer: () => server,
      });
    },
    configureServer(nextServer) {
      server = nextServer;
    },
    resolveId(id) {
      return core.resolveId(id);
    },
    load(id) {
      return core.load(id);
    },
    async transform(code, id) {
      evaluator?.setHost({
        resolve: async (source, importer) => {
          let resolved = await this.resolve(source, importer);
          if (!resolved) return null;

          return {
            external: resolved.external === true || resolved.external === "absolute",
            id: resolved.id,
          };
        },
        load: async (id) => {
          let loaded = await this.load({ id, resolveDependencies: false });
          return loaded.code;
        },
      });

      try {
        let result = await core.transform(code, id, {
          addWatchFile: this.addWatchFile.bind(this),
          resolve: async (source, importer) => {
            let resolved = await this.resolve(source, importer);
            if (!resolved || resolved.external) return null;
            return resolved.id;
          },
        });
        return result ?? undefined;
      } finally {
        evaluator?.setHost(undefined);
      }
    },
    watchChange(id) {
      core.invalidate(id);
    },
    handleHotUpdate(context) {
      core.invalidate(context.file);
    },
    async buildEnd() {
      await evaluator?.dispose();
    },
    async closeBundle() {
      await evaluator?.dispose();
    },
  };
}

function invalidateVirtualModule(server: ViteDevServer, id: string): void {
  let module = server.moduleGraph.getModuleById(id);
  if (module) {
    server.moduleGraph.invalidateModule(module);
  }

  let ssrGraph = server.environments?.ssr?.moduleGraph;
  let ssrModule = ssrGraph?.getModuleById(id);
  if (ssrModule) {
    ssrGraph?.invalidateModule(ssrModule);
  }
}
