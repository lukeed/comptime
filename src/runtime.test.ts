import { describe, expect, test } from "bun:test";
import { comptime } from "./runtime";

describe("runtime stub", () => {
  test("throws when the plugin did not replace a comptime call", () => {
    expect(() => comptime(() => 1)).toThrow(
      "comptime() must be replaced by the Vite or Rolldown plugin before runtime",
    );
  });

  test("is typed as an identity helper", () => {
    if (false) {
      let value: "hi" = comptime((): "hi" => "hi");
      expect(value).toBe("hi");
    }
  });
});
