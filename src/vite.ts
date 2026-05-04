import type { Plugin, ViteDevServer } from "vite";
import { BundleEvaluator, readDefaultExport } from "./evaluator";
import type { ComptimeOptions, Evaluator } from "./shared";
import { createCore } from "./shared";

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
      let module = await server.ssrLoadModule(virtualId, { fixStacktrace: true });
      return readDefaultExport(module);
    }
    return await this.fallback.evaluate(virtualId, body, origin);
  }

  async dispose(): Promise<void> {
    await this.fallback.dispose();
  }
}

export function comptime(options?: ComptimeOptions): Plugin {
  let server: ViteDevServer | undefined;
  let evaluator: Evaluator | undefined;
  let core =
    options === undefined
      ? createCore({ getEvaluator })
      : createCore({ getEvaluator, options });

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
        fallback: new BundleEvaluator({ core, cwd: config.root }),
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
      let result = await core.transform(code, id, {
        addWatchFile: (file) => this.addWatchFile(file),
      });
      return result ?? undefined;
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
