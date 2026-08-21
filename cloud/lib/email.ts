import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { env } from "@/lib/env";

/**
 * Outbound email via Amazon SES — same pattern as ~/claude/elevate and
 * ~/claude/clarify's lib/email.ts (Will, V-T3 item 5: "Use amazon SES for
 * email like we use in other apps").
 *
 * Nothing in this app calls sendEmail() yet — there's no email-sending
 * feature built here today (checked: the only existing email surface is
 * app/api/webhooks/ses/route.ts, which is INBOUND mail receipt, a
 * separate concern). This helper exists so a future outbound feature
 * (e.g. the Ordering tab's reorder-confirmation email once that's built)
 * has a ready, consistent SES client to call into instead of each
 * feature wiring up its own — see .env.example for the AWS_ and SES_FROM
 * vars this reads.
 */

export interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

let client: SESClient | undefined;

function getClient(): SESClient {
  client ??= new SESClient({
    region: env.awsRegion(),
    credentials: {
      accessKeyId: env.awsAccessKeyId() ?? "",
      secretAccessKey: env.awsSecretAccessKey() ?? "",
    },
  });
  return client;
}

export async function sendEmail({ to, subject, html, text }: EmailOptions): Promise<void> {
  if (!env.awsAccessKeyId() || !env.awsSecretAccessKey()) {
    throw new Error(
      "AWS SES credentials not configured (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY missing).",
    );
  }

  await getClient().send(
    new SendEmailCommand({
      Source: env.sesFromAddress(),
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: subject, Charset: "UTF-8" },
        Body: {
          Html: { Data: html, Charset: "UTF-8" },
          Text: { Data: text ?? html.replace(/<[^>]+>/g, ""), Charset: "UTF-8" },
        },
      },
    }),
  );
}
