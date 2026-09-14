import { describe, expect, it } from "vitest";
import { labelDeviceFromUserAgent } from "@/lib/session-device-label";

describe("labelDeviceFromUserAgent", () => {
  it("labels a null/missing user agent as the Windows desktop app", () => {
    expect(labelDeviceFromUserAgent(null)).toBe("Windows desktop app");
    expect(labelDeviceFromUserAgent(undefined)).toBe("Windows desktop app");
    expect(labelDeviceFromUserAgent("")).toBe("Windows desktop app");
    expect(labelDeviceFromUserAgent("   ")).toBe("Windows desktop app");
  });

  it("labels a non-browser user agent (e.g. gotrue-csharp's default) as the Windows desktop app", () => {
    expect(labelDeviceFromUserAgent("gotrue-csharp/1.6.0")).toBe("Windows desktop app");
  });

  it("labels Chrome on Windows", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
    expect(labelDeviceFromUserAgent(ua)).toBe("Chrome on Windows");
  });

  it("labels Safari on Mac", () => {
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
    expect(labelDeviceFromUserAgent(ua)).toBe("Safari on Mac");
  });

  it("labels Firefox on Linux", () => {
    const ua = "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";
    expect(labelDeviceFromUserAgent(ua)).toBe("Firefox on Linux");
  });

  it("labels Edge on Windows (distinct from Chrome despite sharing the chrome/ token)", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0";
    expect(labelDeviceFromUserAgent(ua)).toBe("Edge on Windows");
  });

  it("labels a mobile Safari (iOS) user agent", () => {
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
    expect(labelDeviceFromUserAgent(ua)).toBe("Safari on iOS");
  });
});
