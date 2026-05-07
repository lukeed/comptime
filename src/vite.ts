import { createCore, createViteEvaluationId } from "./shared";
import { ModuleRunnerEvaluator, readDefaultExport } from "./evaluator";

import type { Plugin, ViteDevServer } from "vite";
import type { EvaluatorHost } from "./evaluator";
import type { ComptimeOptions, Evaluator } from "./shared";

export type { Serializer } from "./shared";

type ViteEvaluatorOptions = {
  fallback: Evaluator;
  getServer(): ViteDevServer | undefined;
};

class ViteEvaluator implements Evaluator {
  private readonly fallback: Evaluator;
  private readonly getServer: () => ViteDevServer | undefined;

  constructor(options: ViteEvaluatorOptions) {
    this.fallback = options.fallback;
    this.getServer = options.getServer;
  }

  async evaluate(virtualId: string, body: string, origin: string): Promise<unknown> {
    let server = this.getServer();
    if (server) {
      invalidateVirtualModule(server, virtualId);
      let viteVirtualId = createViteEvaluationId(origin, virtualId);
      // Vite dev loads the alias so its normal TS/TSX transform runs; build fallback keeps using
      // the internal \0 id that the module runner can import directly.
      invalidateVirtualModule(server, viteVirtualId);
      return readDefaultExport(await server.ssrLoadModule(viteVirtualId, { fixStacktrace: true }));
    }
    return await this.fallback.evaluate(virtualId, body, origin);
  }

  setHost(host: EvaluatorHost | undefined): void {
    setEvaluatorHost(this.fallback, host);
  }

  dispose(): Promise<void> {
    return this.fallback.dispose();
  }
}

export function comptime(options?: ComptimeOptions): Plugin {
  let server: ViteDevServer | undefined;
  let evaluator: Evaluator | undefined;
  let core = options != null ? createCore({ getEvaluator, options }) : createCore({ getEvaluator });

  function getEvaluator(): Evaluator {
    if (!evaluator) {
      throw new Error("comptime evaluator was used before configResolved");
    }
    return evaluator;
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
      setEvaluatorHost(evaluator, {
        resolve: async (source, importer) => {
          let resolved = await this.resolve(source, importer);
          if (!resolved) {
            return null;
          }
          return {
            external: resolved.external === true || resolved.external === "absolute",
            id: resolved.id,
          };
        },
        load: async (moduleId) => {
          let loaded = await this.load({ id: moduleId, resolveDependencies: false });
          return loaded.code;
        },
      });
      try {
        let result = await core.transform(code, id, {
          addWatchFile: (file) => this.addWatchFile(file),
        });
        return result ?? undefined;
      } finally {
        setEvaluatorHost(evaluator, undefined);
      }
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

function setEvaluatorHost(evaluator: Evaluator | undefined, host: EvaluatorHost | undefined): void {
  if (evaluator && "setHost" in evaluator && typeof evaluator.setHost === "function") {
    evaluator.setHost(host);
  }
}
