import { describe, expect, it } from "vitest";
import {
  dateInputValidationMessage,
  digitsToIso,
  formatDigitsAsMaskedDate,
  isValidCalendarDate,
  isoToMaskedDate,
  maskDateInput,
  normalizePastedDateText,
  onlyDigits,
  parseSeparatedDateText,
  reorderIfYyyyMmDd,
} from "@/lib/date-mask";

describe("onlyDigits", () => {
  it("strips every non-digit character", () => {
    expect(onlyDigits("09/16/2028")).toBe("09162028");
    expect(onlyDigits("abc123-45.6")).toBe("123456");
  });
});

describe("formatDigitsAsMaskedDate", () => {
  it("inserts '/' progressively as digits accumulate", () => {
    expect(formatDigitsAsMaskedDate("0")).toBe("0");
    expect(formatDigitsAsMaskedDate("09")).toBe("09");
    expect(formatDigitsAsMaskedDate("091")).toBe("09/1");
    expect(formatDigitsAsMaskedDate("0916")).toBe("09/16");
    expect(formatDigitsAsMaskedDate("09162")).toBe("09/16/2");
    expect(formatDigitsAsMaskedDate("09162028")).toBe("09/16/2028");
  });

  it("ignores digits past the 8th", () => {
    expect(formatDigitsAsMaskedDate("091620289999")).toBe("09/16/2028");
  });
});

describe("maskDateInput (typing/backspace path)", () => {
  it("formats a raw typed value (already containing the mask's own slashes) the same as formatDigitsAsMaskedDate", () => {
    expect(maskDateInput("09/16/2028")).toBe("09/16/2028");
    expect(maskDateInput("09/16/202")).toBe("09/16/202"); // backspace from the end
    expect(maskDateInput("09/1")).toBe("09/1");
    expect(maskDateInput("")).toBe("");
  });

  it("reinterprets an unseparated 8-digit YYYY-MM-DD-shaped run (e.g. fast paste-like entry)", () => {
    expect(maskDateInput("20280916")).toBe("09/16/2028");
  });
});

describe("reorderIfYyyyMmDd", () => {
  it("reorders an 8-digit run that's implausible as MM/DD/YYYY but plausible as YYYY/MM/DD", () => {
    expect(reorderIfYyyyMmDd("20280916")).toBe("09162028");
  });

  it("leaves an already-plausible MM/DD/YYYY 8-digit run unchanged", () => {
    expect(reorderIfYyyyMmDd("09162028")).toBe("09162028");
  });

  it("leaves anything shorter than 8 digits unchanged", () => {
    expect(reorderIfYyyyMmDd("2028091")).toBe("2028091");
  });

  it("leaves an 8-digit run unchanged when NEITHER reading is plausible", () => {
    expect(reorderIfYyyyMmDd("99999999")).toBe("99999999");
  });
});

describe("parseSeparatedDateText", () => {
  it("parses 'MM/DD/YYYY'", () => {
    expect(parseSeparatedDateText("09/16/2028")).toBe("09162028");
  });

  it("parses 'M/D/YY' with a 2-digit year expanding to 20xx", () => {
    expect(parseSeparatedDateText("9/16/28")).toBe("09162028");
  });

  it("accepts '-' and '.' as separators too", () => {
    expect(parseSeparatedDateText("9-16-2028")).toBe("09162028");
    expect(parseSeparatedDateText("9.16.2028")).toBe("09162028");
  });

  it("returns null for an implausible month/day", () => {
    expect(parseSeparatedDateText("13/40/2028")).toBeNull();
  });

  it("returns null for text with no recognizable separated-date shape", () => {
    expect(parseSeparatedDateText("not a date")).toBeNull();
    expect(parseSeparatedDateText("20280916")).toBeNull(); // no separators — not this function's job
  });
});

describe("isValidCalendarDate", () => {
  it("accepts a real date", () => {
    expect(isValidCalendarDate(2028, 9, 16)).toBe(true);
  });

  it("rejects Feb 30 (JS Date would otherwise silently roll it into March)", () => {
    expect(isValidCalendarDate(2026, 2, 30)).toBe(false);
  });

  it("rejects month 13 and day 32", () => {
    expect(isValidCalendarDate(2026, 13, 1)).toBe(false);
    expect(isValidCalendarDate(2026, 1, 32)).toBe(false);
  });

  it("accepts Feb 29 on a leap year, rejects it otherwise", () => {
    expect(isValidCalendarDate(2028, 2, 29)).toBe(true); // 2028 is a leap year
    expect(isValidCalendarDate(2026, 2, 29)).toBe(false);
  });
});

describe("digitsToIso", () => {
  it("converts a valid 8-digit MMDDYYYY run to ISO", () => {
    expect(digitsToIso("09162028")).toBe("2028-09-16");
  });

  it("returns null for a short digit run", () => {
    expect(digitsToIso("0916202")).toBeNull();
  });

  it("returns null for an 8-digit run that isn't a real calendar date", () => {
    expect(digitsToIso("02302026")).toBeNull(); // Feb 30
    expect(digitsToIso("13012028")).toBeNull(); // month 13
  });
});

describe("isoToMaskedDate", () => {
  it("converts a stored ISO date to MM/DD/YYYY", () => {
    expect(isoToMaskedDate("2028-09-16")).toBe("09/16/2028");
  });

  it("returns '' for null/undefined/empty", () => {
    expect(isoToMaskedDate(null)).toBe("");
    expect(isoToMaskedDate(undefined)).toBe("");
    expect(isoToMaskedDate("")).toBe("");
  });
});

describe("normalizePastedDateText — Will's three documented paste shapes", () => {
  it("'09/16/2028' -> '09/16/2028'", () => {
    expect(normalizePastedDateText("09/16/2028")).toBe("09/16/2028");
  });

  it("'9/16/28' -> '09/16/2028'", () => {
    expect(normalizePastedDateText("9/16/28")).toBe("09/16/2028");
  });

  it("'20280916' -> '09/16/2028'", () => {
    expect(normalizePastedDateText("20280916")).toBe("09/16/2028");
  });
});

// V-T-lots-ux-round3 (Will verbatim: "I just typed '01' in a date and it
// didn't show an error, it just didn't do anything") — a partial date
// used to silently collapse to no feedback. See this helper's own doc
// comment for the full decision table.
describe("dateInputValidationMessage", () => {
  it("shows no message for an empty field regardless of focus", () => {
    expect(dateInputValidationMessage("", "focused")).toBeNull();
    expect(dateInputValidationMessage("", "blurred")).toBeNull();
  });

  it("shows no message for 1-7 digits while still focused (don't nag mid-typing)", () => {
    expect(dateInputValidationMessage("0", "focused")).toBeNull();
    expect(dateInputValidationMessage("01", "focused")).toBeNull();
    expect(dateInputValidationMessage("0916202", "focused")).toBeNull();
  });

  it("shows the 'enter full date' message for 1-7 digits once blurred (Will's exact bug)", () => {
    expect(dateInputValidationMessage("01", "blurred")).toBe("Enter the full date as MM/DD/YYYY");
    expect(dateInputValidationMessage("0916202", "blurred")).toBe("Enter the full date as MM/DD/YYYY");
  });

  it("shows 'Not a valid date' for 8 digits that aren't a real calendar date, focused or blurred", () => {
    expect(dateInputValidationMessage("02302026", "focused")).toBe("Not a valid date");
    expect(dateInputValidationMessage("02302026", "blurred")).toBe("Not a valid date");
    expect(dateInputValidationMessage("13012028", "blurred")).toBe("Not a valid date");
  });

  it("shows no message for 8 digits that form a real calendar date", () => {
    expect(dateInputValidationMessage("09162028", "focused")).toBeNull();
    expect(dateInputValidationMessage("09162028", "blurred")).toBeNull();
  });
});
