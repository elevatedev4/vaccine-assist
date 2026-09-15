import { describe, expect, it } from "vitest";
import {
  INSTALL_EMAIL_FALLBACK,
  INSTALL_PASSWORD_PLACEHOLDER,
  buildInstallOneLiner,
} from "@/lib/install-instructions";

describe("buildInstallOneLiner", () => {
  it("builds the exact one-liner with the signed-in user's email and this deployment's server URL", () => {
    const result = buildInstallOneLiner({
      serverUrl: "https://vaccine-assist.vercel.app",
      email: "tech@orchardsdrug.com",
    });
    expect(result).toBe(
      "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; " +
        "& ([scriptblock]::Create((irm https://raw.githubusercontent.com/elevatedev4/vaccine-assist/main/bootstrap-fresh.ps1))) " +
        "-Email tech@orchardsdrug.com -Password 'the-shared-password' -ServerUrl https://vaccine-assist.vercel.app"
    );
  });

  it("falls back to the placeholder email when no session email is known", () => {
    const result = buildInstallOneLiner({ serverUrl: "https://vaccine-assist.vercel.app", email: null });
    expect(result).toContain(`-Email ${INSTALL_EMAIL_FALLBACK} `);
  });

  it("falls back to the placeholder email for an empty/whitespace-only email", () => {
    const result = buildInstallOneLiner({ serverUrl: "https://vaccine-assist.vercel.app", email: "   " });
    expect(result).toContain(`-Email ${INSTALL_EMAIL_FALLBACK} `);
  });

  it("always keeps -Password single-quoted around the literal placeholder, never a real password", () => {
    const result = buildInstallOneLiner({ serverUrl: "https://vaccine-assist.vercel.app", email: "a@b.com" });
    expect(result).toContain(`-Password '${INSTALL_PASSWORD_PLACEHOLDER}'`);
    expect(result).not.toContain('-Password "');
  });

  it("uses the given serverUrl verbatim as -ServerUrl (so it always matches the current deployment)", () => {
    const result = buildInstallOneLiner({ serverUrl: "https://preview-123.vercel.app", email: "a@b.com" });
    expect(result.endsWith("-ServerUrl https://preview-123.vercel.app")).toBe(true);
  });
});
