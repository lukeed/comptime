import { comptime } from "comptime";

let message = comptime<string>(() => readReleaseManifest());

let target = document.querySelector("#message");

if (target instanceof HTMLElement) {
  target.textContent = message;
}

function readReleaseManifest(): string {
  throw new Error("missing RELEASE_MANIFEST_PATH for errors example");
}
