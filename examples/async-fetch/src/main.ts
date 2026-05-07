import { comptime } from "comptime";

type Payload = {
  source: string;
  values: number[];
  total: number;
};

let payload = comptime<Payload>(async () => {
  let response = await fetch(
    "data:application/json,%7B%22source%22%3A%22data-url%22%2C%22values%22%3A%5B3%2C5%2C8%2C13%5D%7D",
  );
  let value: unknown = await response.json();
  return readPayload(value);

  function readPayload(input: unknown): Payload {
    if (!isRecord(input) || typeof input.source !== "string" || !Array.isArray(input.values)) {
      throw new Error("Unexpected payload shape");
    }

    let values = input.values.filter((item) => typeof item === "number");
    return {
      source: input.source,
      values,
      total: values.reduce((sum, item) => sum + item, 0),
    };
  }

  function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === "object" && input !== null;
  }
});

let target = document.querySelector("#payload");

if (target) {
  target.textContent = JSON.stringify(payload, null, 2);
}
