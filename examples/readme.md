# examples

- **fibonacci** &mdash; replace a recursive Fibonacci call with a literal<br>
  _**Why?** Demonstrates the smallest possible build-time computation._
- **preact-render-to-string** &mdash; render Preact HTML before the browser runs<br>
  _**Why?** Ships the final static markup instead of the render-to-string pipeline._
- **env-stamping** &mdash; compile-time ENV injection and assertion<br>
  _**Why?** Fails early for bad release metadata and ships the resolved stamp as data._
- **markdown-precompile** &mdash; convert markdown to HTML at build time<br>
  _**Why?** Avoids shipping any remark / markdown-it / md4x pipeline to the browser._
- **lookup-table** &mdash; generate a numeric lookup table once during bundling<br>
  _**Why?** Moves deterministic setup work out of startup and into the build._
- **async-fetch** &mdash; fetch and normalize JSON inside the build<br>
  _**Why?** Lets static remote or generated data become a plain bundled object._
- **custom-serializer** &mdash; teach comptime how to emit a non-default value<br>
  _**Why?** Keeps domain objects like URLs typed at runtime without hand-written glue._
- **errors** &mdash; intentionally throw during comptime evaluation<br>
  _**Why?** Shows the build/dev error shape and call-site frame when compile-time code fails._

Build the package once from the repo root before running examples:

```sh
bun run build
```

Then run an example from its directory:

```sh
bun run vite:dev
bun run vite:build
bun run rd:dev
bun run rd:build
```
