import type { Plugin } from "rolldown";
import { BundleEvaluator } from "./evaluator";
import type { ComptimeOptions, Evaluator } from "./shared";
import { createCore } from "./shared";

export function comptime(options?: ComptimeOptions): Plugin {
  let evaluator: Evaluator | undefined;
  let core =
    options === undefined
      ? createCore({ getEvaluator })
      : createCore({ getEvaluator, options });

  function getEvaluator(): Evaluator {
    if (!evaluator) {
      throw new Error("comptime evaluator was used before buildStart");
    }
    return evaluator;
  }

  return {
    name: "comptime",
    buildStart() {
      evaluator = new BundleEvaluator({ core, cwd: process.cwd() });
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
    async buildEnd() {
      await evaluator?.dispose();
    },
  };
}
