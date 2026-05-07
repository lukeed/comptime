import { comptime } from "comptime";

let html = comptime(async () => {
  let { h } = await import("preact");
  let { default: render } = await import("preact-render-to-string");
  let details = [
    { label: "renderer", value: "preact-render-to-string" },
    { label: "timing", value: "inside comptime()" },
    { label: "runtime", value: "static HTML string" },
  ];

  return render(
    h("article", { class: "summary-card" }, [
      h("p", { class: "eyebrow" }, "comptime preact"),
      h("h1", null, "Rendered before the bundle runs"),
      h(
        "dl",
        null,
        details.map((detail) =>
          h("div", { class: "detail", key: detail.label }, [
            h("dt", null, detail.label),
            h("dd", null, detail.value),
          ]),
        ),
      ),
    ]),
  );
});
let output = document.querySelector("#output");

if (output) {
  output.innerHTML = html;
}

console.log(html);
