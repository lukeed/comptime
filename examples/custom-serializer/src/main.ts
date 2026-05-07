import { comptime } from "comptime";

let assetUrl = comptime(() => new URL("/manual?chapter=serializers", "https://example.com"));
let target = document.querySelector("#asset");

if (target instanceof HTMLAnchorElement) {
  target.href = assetUrl.href;
  target.textContent = assetUrl.href;
}
