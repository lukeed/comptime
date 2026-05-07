import { comptime } from "comptime";

type Sample = {
  index: number;
  degrees: number;
  sine: number;
  cosine: number;
};

let samples = comptime<Sample[]>(() =>
  Array.from({ length: 16 }, (_item, index) => {
    let radians = (index / 16) * Math.PI * 2;
    return {
      index,
      degrees: Math.round((radians * 180) / Math.PI),
      sine: Number(Math.sin(radians).toFixed(3)),
      cosine: Number(Math.cos(radians).toFixed(3)),
    };
  }),
);

let target = document.querySelector("#samples");

if (target) {
  target.innerHTML = samples
    .map(
      (sample) => `
        <div class="sample">
          <span>${sample.degrees}deg</span>
          <meter min="-1" max="1" value="${sample.sine}"></meter>
          <code>sin ${sample.sine} / cos ${sample.cosine}</code>
        </div>
      `,
    )
    .join("");
}
