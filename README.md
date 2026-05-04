# comptime

> A Zig-inspired build-time evaluation primitive for TypeScript, exposed as Vite and Rolldown plugins.

```ts
import { comptime } from "comptime";
import { fibonacci } from "./math";

export const value = comptime(() => fibonacci(10));
```

With the plugin enabled, the call is evaluated during the build and replaced with a serialized expression:

```ts
export const value = 55;
```

If the plugin is not enabled, the runtime helper throws so missed transforms fail loudly.

## Install

```sh
# via rolldown
bun add --dev comptime rolldown

# via vite
bun add --dev comptime vite
```

## Vite

```ts
import { defineConfig } from "vite";
import { comptime } from "comptime/vite";

export default defineConfig({
  plugins: [comptime()],
});
```

## Rolldown

```ts
import { defineConfig } from "rolldown";
import { comptime } from "comptime/rolldown";

export default defineConfig({
  input: "src/app.ts",
  plugins: [comptime()],
});
```

## API

```ts
import { comptime } from "comptime";

let value = comptime(() => expensivePureWork());
```

`comptime<T>(fn: () => T): T` is typed as an identity helper. The plugin requires a single zero-argument arrow function or function expression.

Supported behavior:

- Imported `comptime` bindings from `"comptime"`, including aliases.
- Shadowed local bindings are ignored.
- Referenced value imports are captured into virtual modules with absolute import paths.
- Referenced top-level declarations from the origin module are copied into the virtual module.
- Promise-returning bodies are awaited.
- Values are serialized with `devalue`.
- Build errors include the original call-site location.
- Vite dev uses `server.ssrLoadModule`; Vite build and Rolldown build use an internal Rolldown evaluator.

## Options

```ts
type ComptimeOptions = {
  include?: string | string[];
  exclude?: string | string[];
  timeout?: number;
  env?: string[] | "all" | "declared";
  customSerializers?: Array<{
    test: (value: unknown) => boolean;
    serialize: (value: unknown) => string;
  }>;
};
```

Defaults:

- `timeout`: `10_000`
- `env`: `"all"`

When `env` is a string list, static `process.env.KEY` reads must be listed. Dynamic env reads are rejected unless `env` is `"all"`.

## Limits

This package does not add browser-side evaluation, disk caching, Webpack support, or esbuild standalone support.

## License

MIT © [Luke Edwards](https://lukeed.com)
