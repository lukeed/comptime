import { describe, expect, test } from "bun:test";
import { comptime } from "./runtime";

describe("runtime stub", () => {
  test("throws when the plugin did not replace a comptime call", () => {
    expect(() => comptime(() => 1)).toThrow("Missing comptime() plugin");
  });

  test("is typed as an identity helper", () => {
    if (false) {
      let value: "hi" = comptime((): "hi" => "hi");
      expect(value).toBe("hi");
    }
  });

  test("awaits promise-returning bodies in the type signature", () => {
    if (false) {
      let value: "hi" = comptime(async (): Promise<"hi"> => "hi");
      expect(value).toBe("hi");
    }
  });
});
