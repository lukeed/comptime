# `comptime` for TypeScript — Implementation Plan

A Zig-inspired build-time evaluation primitive for TypeScript, delivered as Vite and Rolldown plugins.

## 1. Goals & non-goals

### Goals

- Evaluate expressions at build time; replace call sites with serialized literal values.
- Full TypeScript type inference for return values (no codegen, no `.d.ts` ceremony beyond a single declaration).
- Support the user's full module graph inside comptime bodies (imports, TS, project plugins all work).
- First-class Vite (dev + build) and Rolldown (build) support, sharing as much logic as possible.
- Clear build-time errors for unserializable values, evaluation throws, and unresolvable dependencies.
- Source maps that point back to the original `comptime(...)` call site.

### Non-goals (for v1)

- Custom syntax (`do comptime: { break comptime ... }`). Function-call form only — see §2.
- Browser-side comptime (everything runs in Node during build).
- Caching across processes / on-disk persistence beyond what Vite already does.
- Webpack, esbuild standalone, or other bundlers. Vite/Rolldown share enough surface to justify the focus.

## 2. Public API

### User-facing

A single helper, typed as identity, replaced at build time:

```ts
import { comptime } from "comptime";

declare function comptime<T>(fn: () => T): T;
```

Usage:

```ts
import { comptime } from "comptime";
import { fibonacci } from "./math";
import { readdirSync } from "node:fs";

const value = comptime(() => fibonacci(10)); // number
const routes = comptime(() => readdirSync("./pages")); // string[]
const buildHash = comptime(() => process.env.GIT_SHA); // string | undefined
```

The function signature gives TS everything it needs — `T` flows from the arrow's return type to the binding. If the bundler plugin doesn't run, the runtime stub throws a clear error so silent regressions are impossible.

### Package layout

A single npm package, `comptime`, with subpath exports:

```
comptime/                  → runtime stub + types (the declare-and-throw helper)
comptime/vite              → Vite plugin
comptime/rolldown          → Rolldown plugin
comptime/shared (internal) → AST walking, evaluation orchestration, serialization
```

`package.json` exports:

```json
{
  "name": "comptime",
  "exports": {
    ".": {
      "types": "./dist/runtime.d.ts",
      "import": "./dist/runtime.js"
    },
    "./vite": {
      "types": "./dist/vite.d.ts",
      "import": "./dist/vite.js"
    },
    "./rolldown": {
      "types": "./dist/rolldown.d.ts",
      "import": "./dist/rolldown.js"
    }
  }
}
```

Why two integration packages instead of one universal plugin: Vite and Rolldown share the Rollup plugin shape but diverge meaningfully on module evaluation. Vite has a running dev server with `ssrLoadModule` / Module Runner during `serve`, plus its own Module Runner for `build`. Rolldown is build-only and exposes its own `moduleRunnerTransform` from `rolldown/experimental`. Sharing a single plugin would either duplicate branching logic at every step or settle for the lowest common denominator. Two thin adapters over one shared core is the cleaner factoring.

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      User Source File                       │
│            const x = comptime(() => fib(10));               │
└──────────────────────────┬──────────────────────────────────┘
                           │ transform() hook
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                  comptime/shared (core)                     │
│  1. Detect comptime() calls (string scan + AST confirm)     │
│  2. Extract function bodies → virtual modules               │
│  3. Hand virtual modules to the Evaluator                   │
│  4. Receive value, serialize via devalue                    │
│  5. Splice replacement in via magic-string                  │
└──────┬───────────────────────────────────┬──────────────────┘
       │                                   │
       ▼                                   ▼
┌──────────────────┐              ┌────────────────────────────┐
│ Vite Evaluator   │              │ Rolldown Evaluator         │
│ - dev: server    │              │ - build: moduleRunner-     │
│   .ssrLoadModule │              │   Transform from           │
│ - build: Module  │              │   rolldown/experimental    │
│   Runner         │              │   + ModuleRunner client    │
└──────────────────┘              └────────────────────────────┘
```

The shared core never imports from `vite` or `rolldown`. It defines an `Evaluator` interface and consumes it. The integration packages implement that interface using their host's primitives.

### Shared `Evaluator` interface

```ts
// comptime/shared/evaluator.ts
export interface Evaluator {
  /**
   * Evaluate a virtual module and return the value of its default export.
   * @param virtualId  Unique id for the comptime call site (e.g. "\0comptime:/abs/path.ts:42")
   * @param body       The function body, ready to be wrapped as a module
   * @param origin     Absolute path of the file that contains the comptime() call
   */
  evaluate(virtualId: string, body: string, origin: string): Promise<unknown>;

  /** Tear down workers, close runners, etc. */
  dispose(): Promise<void>;
}
```

## 4. Detection & extraction

Inside the `transform` hook (both plugins):

1. **Fast path filter.** Skip files that don't contain the literal substring `comptime(`. Skip non-JS/TS files.
2. **Parse with OXC.** `oxc-parser` is fast, supports TS/JSX, and is what Rolldown uses internally. (Vite 6+ also uses Rolldown for builds, so this stays consistent.)
3. **Walk for `CallExpression` nodes** where the callee is an identifier `comptime` whose binding traces back to an import from the `comptime` package. Reject otherwise — this prevents collisions with user code that happens to define a local `comptime` variable.
4. **Validate the argument.** Must be a single `ArrowFunctionExpression` or `FunctionExpression` with no parameters. Anything else is a build error with a code frame.
5. **Extract** the function body source range and any imports referenced by free variables in the body. (Free-variable resolution happens lexically; we look at all `Identifier` nodes in the body and resolve them against the surrounding module's imports/declarations.)

Each detected call yields:

```ts
type ComptimeCall = {
  start: number; // byte offset of `comptime(` in source
  end: number; // byte offset after the closing `)`
  body: string; // function body, e.g. "return fib(10)"
  capturedImports: Import[]; // imports the body needs to run
  origin: string; // absolute path of containing file
  index: number; // ordinal within the file (for stable virtual ids)
};
```

## 5. Virtual modules

For each `ComptimeCall`, the plugin synthesizes a virtual module:

```ts
// virtual id: "\0comptime:/abs/path/to/file.ts:0"

import { fibonacci } from "/abs/path/to/math.ts";
// ...other captured imports...

export default await (async () => {
  return fibonacci(10);
})();
```

Virtual ids use the leading `\0` convention so other plugins skip them. The plugin claims them in `resolveId` and serves their content in `load`. Captured imports are rewritten to absolute paths so the host's resolver doesn't have to re-walk the call site's directory.

This approach gets us **transitive transforms for free**: the host runs its full plugin pipeline on the virtual module, including TS, project aliases, and any user plugins that the captured imports depend on.

## 6. Evaluation

### Vite (`comptime/vite`)

Two modes, picked from `config.command` in `configResolved`:

**Dev (`serve`)** — use the existing dev server's module loader. The plugin holds a reference to the `ViteDevServer` (received in `configureServer`). To evaluate, it asks the server to load the virtual module:

```ts
// pseudocode
const mod = await server.ssrLoadModule(virtualId);
return mod.default;
```

This is the cheapest path: the server is already running, modules are already cached, HMR invalidates the cache when sources change. (Vite's Environment API and the new Module Runner have started replacing `ssrLoadModule` in newer versions; the adapter abstracts over which one is available so we can support both.)

**Build (`build`)** — instantiate a `ModuleRunner` from `vite/module-runner` connected to the build's transform pipeline:

```ts
import { ModuleRunner, ESModulesEvaluator } from "vite/module-runner";

const runner = new ModuleRunner(
  {
    root: config.root,
    transport: createBuildTransport(/* ... */),
    sourcemapInterceptor: "prepareStackTrace",
  },
  new ESModulesEvaluator(),
);

const mod = await runner.import(virtualId);
return mod.default;
```

The transport bridges runner requests back to Vite's plugin pipeline so the runner sees the same transformed code Vite produces for the build output. (Vite ships helpers for this; we use them rather than rolling our own.)

### Rolldown (`comptime/rolldown`)

Rolldown is build-only — there's no dev server analogue, and `ssrLoadModule` doesn't exist in Rolldown's API. Instead, we use **`moduleRunnerTransform`** from `rolldown/experimental`. This is Rolldown's primitive for transforming source into a form runnable by Vite's `ModuleRunner` outside of a Vite context:

```ts
import { moduleRunnerTransform } from "rolldown/experimental";
import { ModuleRunner, ESModulesEvaluator } from "vite/module-runner";

// Inside the plugin's transform / build phase:
const runner = new ModuleRunner(
  {
    root: rolldownConfig.cwd ?? process.cwd(),
    transport: {
      async invoke(payload) {
        // Resolve the requested module's source through Rolldown's pipeline,
        // then run moduleRunnerTransform on it.
        const source = await loadThroughRolldown(payload.data.id);
        const transformed = await moduleRunnerTransform(source, {
          // options aligning with the runner's expectations
        });
        return { result: transformed };
      },
    },
  },
  new ESModulesEvaluator(),
);

const mod = await runner.import(virtualId);
return mod.default;
```

The shape mirrors Vite's build evaluator — same `ModuleRunner`, same `ESModulesEvaluator`, different transport. That symmetry is the reason both plugins can share the rest of the pipeline.

> **Note:** `moduleRunnerTransform` lives under `rolldown/experimental` as of writing. The plugin should pin a Rolldown version range and update with care; the import path is likely to move as it stabilizes.

## 7. Serialization

After evaluation we have an arbitrary JS value. We need to turn it into a JS expression to splice into the source.

Use **`devalue`** (Rich Harris / Svelte). It handles primitives, arrays, plain objects, `Date`, `Map`, `Set`, `RegExp`, `BigInt`, `URL`, cyclic references, and `undefined`. It emits a JS expression (not just JSON), which is what we need.

```ts
import { uneval } from "devalue";

const literal = uneval(value); // e.g. "new Map([['a',1]])"
```

**Unserializable values** — functions, class instances with private state, DOM nodes, file handles, promises that didn't resolve to plain data — produce a build error with the call site location and a description of which part of the value couldn't be serialized. `devalue` already throws with reasonable messages; we wrap them with source context.

## 8. Replacement & source maps

Use **`magic-string`** to apply edits:

```ts
import MagicString from "magic-string";

const s = new MagicString(originalCode);
for (const call of calls) {
  s.overwrite(call.start, call.end, serialize(call.value));
}
return {
  code: s.toString(),
  map: s.generateMap({ hires: true, source: id }),
};
```

`hires: true` keeps debugger stepping accurate. The replaced expression is shorter than the original `comptime(() => ...)` call, so source positions after each replacement shift; magic-string handles this automatically.

## 9. Caching & invalidation

Comptime evaluation can be expensive and we'd like to avoid redoing it on every build / HMR cycle.

**Cache key per call site:**

```
sha256(
  body                                  // function body source
  + JSON.stringify(capturedImports)     // import names and paths
  + dependencyGraphHash                 // hash of all transitively imported modules
  + relevantEnvVarsHash                 // process.env keys actually read by the body
)
```

Detecting which `process.env` keys the body reads requires a static scan of the body for `process.env.X` and `process.env['X']` access. We don't try to handle dynamic key access (`process.env[someVar]`); if we see one, we conservatively include the entire env in the hash and warn.

**Storage:**

- Dev (Vite): in-memory map, invalidated on file change via `handleHotUpdate`.
- Build: in-memory for the duration of the build only. No disk cache in v1 — Vite/Rolldown both have their own caching layers above us.

**Watching:** in dev, register `this.addWatchFile(path)` for every module the comptime body transitively imports. When any of those changes, invalidate the cache entry and re-run the transform.

## 10. Errors

Every error path produces a Rollup-style error with `loc` pointing at the original `comptime(...)` call site:

| Condition                                          | Error                                                                            |
| -------------------------------------------------- | -------------------------------------------------------------------------------- |
| `comptime` called with non-arrow / wrong arg shape | `comptime() requires a single arrow function with no parameters`                 |
| Body throws during evaluation                      | `comptime evaluation threw: <original message>` (with original stack as `cause`) |
| Body returns unserializable value                  | `comptime returned a value that cannot be serialized: <devalue's reason>`        |
| Body times out (configurable, default 10s)         | `comptime evaluation timed out after Xms`                                        |
| Imports a module that fails to resolve             | `comptime body imports '<spec>' which could not be resolved`                     |
| Body returns a Promise                             | Allowed — we `await` it. If it rejects, treat as a throw.                        |

Errors during build fail the build. Errors during dev show in the overlay and the affected module's import becomes a runtime error (consistent with how Vite handles other transform failures).

## 11. Plugin skeletons

### `comptime/vite`

```ts
import type { Plugin, ViteDevServer } from "vite";
import { createCore } from "comptime/shared";
import { ViteEvaluator } from "./evaluator.js";

export function comptime(options?: ComptimeOptions): Plugin {
  let evaluator: ViteEvaluator;
  let server: ViteDevServer | undefined;

  const core = createCore({ getEvaluator: () => evaluator });

  return {
    name: "comptime",
    enforce: "pre",

    configResolved(config) {
      evaluator = new ViteEvaluator({ command: config.command, config });
    },

    configureServer(s) {
      server = s;
      evaluator.attachServer(s);
    },

    resolveId(id) {
      return core.resolveId(id);
    },
    load(id) {
      return core.load(id);
    },
    async transform(code, id) {
      return core.transform(code, id);
    },

    async buildEnd() {
      await evaluator.dispose();
    },
    async closeBundle() {
      await evaluator.dispose();
    },
  };
}
```

### `comptime/rolldown`

```ts
import type { Plugin } from "rolldown";
import { createCore } from "comptime/shared";
import { RolldownEvaluator } from "./evaluator.js";

export function comptime(options?: ComptimeOptions): Plugin {
  let evaluator: RolldownEvaluator;
  const core = createCore({ getEvaluator: () => evaluator });

  return {
    name: "comptime",
    // Rolldown supports `enforce: 'pre'` via the same Rollup-shaped API.

    buildStart() {
      evaluator = new RolldownEvaluator({
        /* ... */
      });
    },

    resolveId(id) {
      return core.resolveId(id);
    },
    load(id) {
      return core.load(id);
    },
    async transform(code, id) {
      return core.transform(code, id);
    },

    async buildEnd() {
      await evaluator.dispose();
    },
  };
}
```

The two plugins are nearly identical — the divergence is contained in the `Evaluator` implementations.

## 12. Configuration

```ts
type ComptimeOptions = {
  /** Glob of files to scan. Default: all js/ts/jsx/tsx in project root. */
  include?: string | string[];
  exclude?: string | string[];

  /** Per-call evaluation timeout in ms. Default: 10_000. */
  timeoutMs?: number;

  /** Whitelist of env vars the comptime body may read. Default: all. */
  env?: string[] | "all" | "declared";

  /** Custom serializer for value types devalue can't handle. */
  customSerializers?: Array<{
    test: (value: unknown) => boolean;
    serialize: (value: unknown) => string;
  }>;

  /** Override the imported name (e.g. for codebases that already use `comptime`). */
  importName?: string; // default: 'comptime'
};
```

## 13. Testing strategy

### Unit (shared core)

- AST detection: comptime calls are found, non-comptime `comptime`-named functions are not.
- Body extraction: arrow vs function expression, with and without braces, with closures.
- Serialization round-trip for every type devalue supports.
- Error formatting: each error shape matches the documented message and includes the right `loc`.

### Integration (per plugin)

- `comptime(() => 1 + 2)` → literal `3` in output.
- `comptime(() => fib(10))` where `fib` is imported from another module → literal `55`.
- `comptime(() => readdirSync('./fixtures'))` → literal array of filenames.
- TS types: `let x = comptime(() => 'hi' as const);` — `x` is typed `'hi'`.
- HMR: edit a module imported by a comptime body, observe the call site re-evaluates.
- Build: `vite build` and `rolldown` both produce identical output for the same input.
- Source maps: stack traces in evaluator errors point at the original source.

### Cross-plugin parity

A single fixture project run through both plugins should produce byte-identical bundles for the comptime-replaced segments. If they diverge, that's a bug in one of the evaluators.

## 14. Milestones

| #   | Scope                                                        | Exit criteria                                                                    |
| --- | ------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| M0  | Repo, package layout, runtime stub, types                    | `import { comptime } from 'comptime'` type-checks; runtime stub throws if called |
| M1  | Shared core: detection, extraction, virtual module synthesis | Unit tests green for AST walking and body extraction                             |
| M2  | `comptime/vite` dev mode                                     | `comptime(() => 1+2)` works in `vite` dev server with HMR                        |
| M3  | `comptime/vite` build mode via Module Runner                 | `vite build` produces correct bundles; closures over imports work                |
| M4  | `comptime/rolldown` build mode via `moduleRunnerTransform`   | Rolldown produces bundles matching Vite build output for shared fixtures         |
| M5  | Serialization, errors, timeouts, env tracking                | All documented error shapes pass tests; timeout works                            |
| M6  | Caching + watch integration                                  | HMR re-evaluates only when relevant deps change; build cache is correct          |
| M7  | Docs, examples, public release                               | README, recipes, migration notes, semver-stable 0.1.0                            |

## 15. Open questions

- **Which Vite versions to support?** Module Runner is stable in 6+ but the API has shifted. Probably target 6+ and document the floor.
- **Async comptime bodies.** v1 awaits returned promises. Should we also accept `async () => ...` directly? (Likely yes — same handling.)
- **Top-level await inside the body.** Module Runner supports it; we should test that it actually works through the virtual module wrapper.
- **What to do about `import.meta`?** Inside a comptime body, `import.meta.url` should probably reflect the _origin_ file, not the virtual module. Worth a deliberate design pass.
- **Eventual `do comptime:` syntax.** Out of scope for v1, but the function-call form is a clean migration target — `comptime(() => x)` desugars naturally from `do comptime: x` if we ever ship a parser fork.
