# Plugin lifecycle

## Transform flow

```mermaid
flowchart TD
  subgraph Plugin["Vite / Rolldown plugin"]
    A[config/build start] --> B[create core]
    A --> C[create evaluator]
    D[resolveId hook] --> E[core.resolveId]
    F[load hook] --> G[core.load]
    H[transform hook] --> I[set evaluator host: resolve/load]
    I --> J[core.transform code, id, context]
    J --> K[clear evaluator host]
  end

  subgraph Core["core.transform"]
    J --> L[scan + parse source]
    L --> M[find comptime calls]
    M --> N[capture imports/declarations/env reads]
    N --> O[resolve literal dynamic imports via context.resolve]
    O --> P[create virtual module]
    P --> Q["register internal id: \\0comptime:..."]
    P --> R["register Vite dev id: source?comptime=n"]
    Q --> S[cache lookup]
    S --> T[evaluator.evaluate virtual id]
    T --> U[serialize result]
    U --> V[overwrite comptime call]
  end

  subgraph NativeResolve["Native bundler resolution"]
    O --> W[Vite/Rolldown this.resolve]
    W --> X[absolute resolved ids in virtual body]
  end
```

## Evaluation flow

```mermaid
sequenceDiagram
  participant Bundler as Vite/Rolldown
  participant Plugin as comptime plugin
  participant Core as core
  participant Eval as ModuleRunnerEvaluator
  participant Host as plugin host
  participant MR as Vite ModuleRunner

  Bundler->>Plugin: transform(source, id)
  Plugin->>Eval: setHost({ resolve, load })
  Plugin->>Core: transform(source, id, { resolve, addWatchFile })

  Core->>Bundler: context.resolve(dynamic import, source id)
  Bundler-->>Core: resolved absolute id

  Core->>Core: create virtual module
  Core->>Eval: evaluate("\\0comptime:source?comptime=0")

  Eval->>MR: import(virtual id)
  MR->>Eval: fetchModule(id, importer)

  alt virtual/internal module
    Eval->>Core: resolveId/load
    Core-->>Eval: virtual source
  else normal dependency
    Eval->>Host: resolve/load
    Host->>Bundler: this.resolve / this.load
    Bundler-->>Host: resolved module/code
    Host-->>Eval: module/code
  end

  Eval->>Eval: rolldown transform + moduleRunnerTransform
  MR-->>Eval: evaluated module
  Eval-->>Core: default export value
  Core-->>Plugin: transformed source
  Plugin->>Eval: setHost(undefined)
  Plugin-->>Bundler: code + sourcemap
```

## Vite dev

Vite dev follows the same core transform path, but `ViteEvaluator.evaluate()` uses
`server.ssrLoadModule(source?comptime=n)` when a dev server is available. The extra
dev id lets Vite run its normal TS/TSX transform on the generated module instead of
loading the internal `\0` id directly.
