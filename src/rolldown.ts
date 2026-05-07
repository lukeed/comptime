import { createCore } from "./shared";
import { ModuleRunnerEvaluator } from "./evaluator";

import type { Plugin } from "rolldown";
import type { Options, Evaluator } from "./shared";

export type { Serializer } from "./shared";

export function comptime(options?: Options): Plugin {
  let evaluator: ModuleRunnerEvaluator | undefined;
  let core = createCore({ getEvaluator, options });

  function getEvaluator(): Evaluator {
    if (evaluator) return evaluator;
    throw new Error("comptime evaluator was used before buildStart");
  }

  return {
    name: "comptime",
    buildStart() {
      evaluator = new ModuleRunnerEvaluator({ core });
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
    async buildEnd() {
      await evaluator?.dispose();
    },
  };
}
