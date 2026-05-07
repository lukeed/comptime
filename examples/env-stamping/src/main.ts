import { comptime } from "comptime";

type Stamp = {
  channel: string;
  builtAt: string;
  assertion: string;
};

let stamp = comptime<Stamp>(() => {
  let channel = process.env.COMPTIME_CHANNEL ?? "local";
  if (channel.trim() === "") {
    throw new Error("COMPTIME_CHANNEL cannot be empty");
  }

  return {
    channel,
    builtAt: new Date().toISOString(),
    assertion: "COMPTIME_CHANNEL is non-empty",
  };
});

let target = document.querySelector("#stamp");

if (target) {
  target.innerHTML = `
    <div><dt>channel</dt><dd>${stamp.channel}</dd></div>
    <div><dt>built at</dt><dd>${stamp.builtAt}</dd></div>
    <div><dt>assertion</dt><dd>${stamp.assertion}</dd></div>
  `;
}
