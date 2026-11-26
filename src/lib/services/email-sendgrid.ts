import { type EnvSource, readEnv } from "../utils/env.ts";
import type {
  EmailDeliveryResult,
  EmailService,
  TransactionalEmailMessage,
} from "./email.ts";
import type { EmailAddresses } from "./email-addresses.ts";

// Twilio SendGrid, through its v3 Mail Send API with plain fetch.
// https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send
//
// Click and open tracking are turned off on every message. With them on,
// SendGrid rewrites links to go through its own redirect, and a signing link
// carries the token that lets someone sign: it must reach the signer as it
// was written, and not pass through anyone else's servers on the way.

const SENDGRID_API_URL = "https://api.sendgrid.com";
const RATE_LIMIT_RETRIES = 3;
const DEFAULT_RATE_LIMIT_WAIT_MS = 1_000;
const MAX_RATE_LIMIT_WAIT_MS = 5_000;

export function readSendGridApiKey(
  env: EnvSource = process.env,
): string | undefined {
  return readEnv(env, "SENDGRID_API_KEY");
}

/** "Name <a@b.c>" or "a@b.c" as SendGrid's {email, name}. */
export function parseMailbox(value: string): { email: string; name?: string } {
  const match = /^\s*(.*?)\s*<([^<>]+)>\s*$/.exec(value);

  if (!match) {
    return { email: value.trim() };
  }

  const name = match[1]?.replace(/^"|"$/g, "").trim();

  return { email: match[2]!.trim(), ...(name ? { name } : {}) };
}

export function buildSendGridPayload(
  message: TransactionalEmailMessage,
  config: EmailAddresses,
) {
  const replyTo = message.replyTo ?? config.supportAddress ?? undefined;

  return {
    ...(message.attachments?.length
      ? {
          attachments: message.attachments.map((attachment) => ({
            content: Buffer.from(attachment.content).toString("base64"),
            disposition: "attachment",
            filename: attachment.filename,
            type: attachment.contentType,
          })),
        }
      : {}),
    categories: [message.template],
    // SendGrid wants text/plain before text/html.
    content: [
      { type: "text/plain", value: message.textBody },
      ...(message.htmlBody
        ? [{ type: "text/html", value: message.htmlBody }]
        : []),
    ],
    from: parseMailbox(config.senderAddress),
    personalizations: [{ to: [{ email: message.to }] }],
    ...(replyTo ? { reply_to: parseMailbox(replyTo) } : {}),
    subject: message.subject,
    tracking_settings: {
      click_tracking: { enable: false, enable_text: false },
      open_tracking: { enable: false },
    },
  };
}

function rateLimitWaitMs(response: Response): number {
  // X-RateLimit-Reset is a Unix time in seconds.
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  const waitMs = Number.isFinite(reset) ? reset * 1000 - Date.now() : NaN;

  return Number.isFinite(waitMs) && waitMs > 0
    ? Math.min(waitMs, MAX_RATE_LIMIT_WAIT_MS)
    : DEFAULT_RATE_LIMIT_WAIT_MS;
}

async function describeFailure(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as {
    errors?: Array<{ field?: string | null; message?: string }>;
  } | null;
  const messages = (body?.errors ?? [])
    .map((error) =>
      error.field ? `${error.field}: ${error.message ?? ""}` : error.message,
    )
    .filter(Boolean);

  return messages.length > 0
    ? `SendGrid refused the email: ${messages.join("; ")}`
    : `SendGrid refused the email (HTTP ${String(response.status)}).`;
}

type CreateSendGridEmailServiceOptions = {
  apiKey: string;
  fetchImpl?: typeof fetch;
  resolveAddresses: () => Promise<EmailAddresses>;
  wait: (milliseconds: number) => Promise<void>;
};

export function createSendGridEmailService({
  apiKey,
  fetchImpl = fetch,
  resolveAddresses,
  wait,
}: CreateSendGridEmailServiceOptions): EmailService {
  async function sendOne(
    message: TransactionalEmailMessage,
    config: EmailAddresses,
  ): Promise<EmailDeliveryResult> {
    const body = JSON.stringify(buildSendGridPayload(message, config));

    // A message turned away for rate is tried again after a short wait, so
    // a signer does not lose their copy to a burst. SendGrid has no
    // idempotency key, so only a 429, which means nothing was accepted, is
    // retried; any other failure is reported.
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetchImpl(`${SENDGRID_API_URL}/v3/mail/send`, {
        body,
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        method: "POST",
      });

      if (response.ok) {
        return {
          accepted: [message.to],
          messageId: response.headers.get("x-message-id") ?? undefined,
          rejected: [],
        };
      }

      if (response.status === 429 && attempt < RATE_LIMIT_RETRIES) {
        await wait(rateLimitWaitMs(response));
        continue;
      }

      throw new Error(await describeFailure(response));
    }
  }

  return {
    async send(message) {
      return sendOne(message, await resolveAddresses());
    },
    async sendBatch(messages) {
      if (messages.some((message) => message.attachments?.length)) {
        throw new Error("Messages with attachments must be sent one by one.");
      }

      const config = await resolveAddresses();
      const results: EmailDeliveryResult[] = [];

      for (const message of messages) {
        results.push(await sendOne(message, config));
      }

      return results;
    },
  };
}

export type SendGridDomainCheck =
  | { result: "verified" }
  | { result: "unverified" }
  | { result: "missing" }
  /** The key may only send mail, so it cannot look at domains. */
  | { result: "restricted" }
  | { message: string; result: "error" };

/**
 * Whether SendGrid has the sender's domain authenticated (Settings, Sender
 * Authentication). A key with only Mail Send access cannot ask; then only a
 * test email can tell.
 */
export async function checkSendGridDomain(
  domain: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SendGridDomainCheck> {
  try {
    const response = await fetchImpl(
      `${SENDGRID_API_URL}/v3/whitelabel/domains?limit=200`,
      { headers: { authorization: `Bearer ${apiKey}` } },
    );

    if (response.status === 401 || response.status === 403) {
      return { result: "restricted" };
    }

    if (!response.ok) {
      return {
        message: `SendGrid answered HTTP ${String(response.status)}.`,
        result: "error",
      };
    }

    const domains = (await response.json()) as Array<{
      domain?: string;
      valid?: boolean;
    }>;
    const wanted = domain.toLowerCase();
    const matches = domains.filter((entry) => {
      const name = entry.domain?.toLowerCase();

      return (
        name !== undefined && (wanted === name || wanted.endsWith(`.${name}`))
      );
    });

    if (matches.length === 0) {
      return { result: "missing" };
    }

    return matches.some((entry) => entry.valid)
      ? { result: "verified" }
      : { result: "unverified" };
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : String(error),
      result: "error",
    };
  }
}
