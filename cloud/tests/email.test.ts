import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sendEmail } from "@/lib/email";

/**
 * V-T3 item 5 (Will: "Use amazon SES for email like we use in other
 * apps") — lib/email.ts mirrors ~/claude/elevate and ~/claude/clarify's
 * SES helper. Nothing in this app calls sendEmail() yet (see that file's
 * doc comment), so there's no send-flow to test end-to-end here (and this
 * suite has no network access to actually hit AWS regardless) — this
 * covers the one piece of real logic that doesn't require a live AWS
 * call: the pre-flight credential check.
 */
const AWS_ENV_KEYS = ["AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "SES_FROM"] as const;

describe("sendEmail", () => {
  beforeEach(() => {
    for (const key of AWS_ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const key of AWS_ENV_KEYS) delete process.env[key];
  });

  it("throws a clear error instead of attempting a call when AWS credentials are unconfigured", async () => {
    await expect(
      sendEmail({ to: "pharmacist@example.test", subject: "Test", html: "<p>hi</p>" }),
    ).rejects.toThrow(/AWS SES credentials not configured/);
  });

  it("still throws when only one of the two required credentials is set", async () => {
    process.env.AWS_ACCESS_KEY_ID = "AKIAEXAMPLE";
    // AWS_SECRET_ACCESS_KEY intentionally left unset.

    await expect(
      sendEmail({ to: "pharmacist@example.test", subject: "Test", html: "<p>hi</p>" }),
    ).rejects.toThrow(/AWS SES credentials not configured/);
  });
});
