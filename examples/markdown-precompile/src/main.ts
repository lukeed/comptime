import { comptime } from "comptime";

let markdown = `
# Build-time markdown

This HTML was rendered by **md4x** inside \`comptime()\`.

| phase | shipped |
| --- | --- |
| markdown parser | no |
| final HTML | yes |

- no runtime parser
- no markdown AST in the browser
- no hydration step
`;

let html = comptime(async () => {
  let { renderToHtml } = await import("md4x/napi");
  return renderToHtml(markdown);
});

let article = document.querySelector("#article");

if (article) {
  article.innerHTML = html;
}
