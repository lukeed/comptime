import { createCore } from "./shared";
import { ModuleRunnerEvaluator, readDefaultExport } from "./evaluator";

import type { Plugin, ViteDevServer } from "vite";
import type { ComptimeOptions, Evaluator } from "./shared";

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
      return readDefaultExport(
        await server.ssrLoadModule(virtualId, { fixStacktrace: true })
      );
    }
    return await this.fallback.evaluate(virtualId, body, origin);
  }

  dispose(): Promise<void> {
    return this.fallback.dispose();
  }
}

export function comptime(options?: ComptimeOptions): Plugin {
  let server: ViteDevServer | undefined;
  let evaluator: Evaluator | undefined;
  let core = options != null
    ? createCore({ getEvaluator, options })
    : createCore({ getEvaluator });

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
