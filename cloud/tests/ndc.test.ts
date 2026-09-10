import { describe, expect, it } from "vitest";
import { formatNdcDashed, formatNdcForStorage } from "@/lib/ndc";

describe("formatNdcDashed", () => {
  it("returns '' for null and undefined", () => {
    expect(formatNdcDashed(null)).toBe("");
    expect(formatNdcDashed(undefined)).toBe("");
  });

  it("formats an 11-digit NDC as 5-4-2 with dashes", () => {
    expect(formatNdcDashed("00069246510")).toBe("00069-2465-10");
    expect(formatNdcDashed("58160082152")).toBe("58160-0821-52");
  });

  it("left-pads a 10-digit NDC with one leading zero, then formats 5-4-2", () => {
    expect(formatNdcDashed("1234567890")).toBe("01234-5678-90");
  });

  it("passes an already-dashed 11-digit NDC through unchanged in value (re-dashes to the same result)", () => {
    expect(formatNdcDashed("00069-2465-10")).toBe("00069-2465-10");
  });

  it("returns a comma-joined multi-NDC field UNCHANGED (not 10 or 11 digits once stripped)", () => {
    const multi = "00005-2000-10, 00005-2000-02";
    expect(formatNdcDashed(multi)).toBe(multi);
  });

  it("returns a non-numeric or wrong-length value UNCHANGED rather than guessing at segmentation", () => {
    expect(formatNdcDashed("abc")).toBe("abc");
    expect(formatNdcDashed("123456789")).toBe("123456789"); // 9 digits
    expect(formatNdcDashed("123456789012")).toBe("123456789012"); // 12 digits
    expect(formatNdcDashed("")).toBe("");
  });
});

describe("formatNdcForStorage", () => {
  it("formats a valid 11-digit NDC, dashed or undashed, as 5-4-2", () => {
    expect(formatNdcForStorage("70461065603")).toBe("70461-0656-03");
    expect(formatNdcForStorage("70461-0656-03")).toBe("70461-0656-03");
  });

  it("rejects a value that isn't 10-11 digits once dashes/whitespace are stripped", () => {
    expect(formatNdcForStorage("123")).toBeNull();
    expect(formatNdcForStorage("123456789012")).toBeNull();
  });
});
