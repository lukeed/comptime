import type { Plugin } from "rolldown";
import { ModuleRunnerEvaluator } from "./evaluator";
import type { ComptimeOptions, Evaluator } from "./shared";
import { createCore } from "./shared";

export function comptime(options?: ComptimeOptions): Plugin {
  let evaluator: ModuleRunnerEvaluator | undefined;
  let core =
    options === undefined ? createCore({ getEvaluator }) : createCore({ getEvaluator, options });

  function getEvaluator(): Evaluator {
    if (!evaluator) {
      throw new Error("comptime evaluator was used before buildStart");
    }
    return evaluator;
  }

  return {
    name: "comptime",
    buildStart() {
      evaluator = new ModuleRunnerEvaluator({ core, cwd: process.cwd() });
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
        evaluator?.setHost(undefined);
      }
    },
    async buildEnd() {
      await evaluator?.dispose();
    },
  };
}
