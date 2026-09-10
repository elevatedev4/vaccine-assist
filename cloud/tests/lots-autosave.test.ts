import { describe, expect, it } from "vitest";
import { decideDateAutosave, decideLotNumberAutosave } from "@/lib/lots-autosave";

describe("decideDateAutosave", () => {
  it("saves a valid, complete, changed date", () => {
    expect(decideDateAutosave("09/16/2026", "")).toBe("save");
    expect(decideDateAutosave("09/16/2026", "08/01/2026")).toBe("save");
  });

  it("never saves a partial date still being typed", () => {
    expect(decideDateAutosave("09/16", "")).toBe("incomplete");
    expect(decideDateAutosave("09", "")).toBe("incomplete");
    expect(decideDateAutosave("", "09/16/2026")).toBe("incomplete");
  });

  it("never saves an 8-digit date that isn't a real calendar date", () => {
    expect(decideDateAutosave("02/30/2026", "")).toBe("invalid");
    expect(decideDateAutosave("13/01/2026", "")).toBe("invalid");
  });

  it("is unchanged when the text matches what was last saved (debounce refiring with no real edit)", () => {
    expect(decideDateAutosave("09/16/2026", "09/16/2026")).toBe("unchanged");
    expect(decideDateAutosave("", "")).toBe("unchanged");
  });
});

describe("decideLotNumberAutosave", () => {
  it("saves a non-empty, changed lot number", () => {
    expect(decideLotNumberAutosave("ABC123", "")).toBe("save");
    expect(decideLotNumberAutosave("ABC123", "XYZ789")).toBe("save");
  });

  it("never saves when the field is cleared to empty", () => {
    expect(decideLotNumberAutosave("", "ABC123")).toBe("empty");
    expect(decideLotNumberAutosave("   ", "ABC123")).toBe("empty");
  });

  it("is unchanged when the text matches what was last saved", () => {
    expect(decideLotNumberAutosave("ABC123", "ABC123")).toBe("unchanged");
    expect(decideLotNumberAutosave("", "")).toBe("unchanged");
  });
});
