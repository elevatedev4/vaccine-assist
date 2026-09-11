import { describe, expect, it } from "vitest";
import { macroProductColor } from "@/lib/macro-colors";

describe("macroProductColor", () => {
  it("is deterministic for the same productKey", () => {
    expect(macroProductColor("ndc:shingrix")).toEqual(macroProductColor("ndc:shingrix"));
  });

  it("gives the two MMR products (same catalog type, different products) different colors", () => {
    const mmr = macroProductColor("name:mmr-ii");
    const priorix = macroProductColor("name:priorix");
    expect(mmr.background).not.toBe(priorix.background);
  });

  it("returns an hsl background and a readable-tone text color", () => {
    const color = macroProductColor("ndc:comirnaty");
    expect(color.background).toMatch(/^hsl\(\d+ \d+% \d+%\)$/);
    expect(color.text).toMatch(/^hsl\(\d+ \d+% \d+%\)$/);
  });
});
