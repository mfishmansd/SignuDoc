import assert from "node:assert/strict";
import { test } from "node:test";

import { createEmailService, resolveEmailDriver } from "./email.ts";
import {
  buildSendGridPayload,
  checkSendGridDomain,
  createSendGridEmailService,
  parseMailbox,
} from "./email-sendgrid.ts";

const ADDRESSES = {
  senderAddress: "Privion <sign@priviontech.com>",
  supportAddress: "support@priviontech.com",
};
const MESSAGE = {
  htmlBody: '<p>Sign <a href="https://sign.example/s/tok">here</a></p>',
  subject: "Please sign",
  template: "signing_invitation" as never,
  textBody: "Sign: https://sign.example/s/tok",
  to: "casey@example.com",
};

test("SendGrid is chosen when it is the only provider with a key, or by name", () => {
  assert.equal(resolveEmailDriver({ SENDGRID_API_KEY: "SG.x" }), "sendgrid");
  assert.equal(
    resolveEmailDriver({ RESEND_API_KEY: "re_x", SENDGRID_API_KEY: "SG.x" }),
    "resend",
  );
  assert.equal(resolveEmailDriver({ EMAIL_DRIVER: "sendgrid" }), "sendgrid");
  assert.equal(resolveEmailDriver({}), "resend");
});

test("without SENDGRID_API_KEY the service refuses to start", () => {
  assert.throws(() =>
    createEmailService({ env: { EMAIL_DRIVER: "sendgrid" } }),
  );
});

test("mailboxes are split into address and name", () => {
  assert.deepEqual(parseMailbox("Privion <sign@priviontech.com>"), {
    email: "sign@priviontech.com",
    name: "Privion",
  });
  assert.deepEqual(parseMailbox("sign@priviontech.com"), {
    email: "sign@priviontech.com",
  });
});

test("the payload keeps links untracked, text before html, and attachments base64", () => {
  const payload = buildSendGridPayload(
    {
      ...MESSAGE,
      attachments: [
        {
          content: new Uint8Array([1, 2, 3]),
          contentType: "application/pdf",
          filename: "signed.pdf",
        },
      ],
    },
    ADDRESSES,
  );

  assert.equal(payload.tracking_settings.click_tracking.enable, false);
  assert.equal(payload.tracking_settings.open_tracking.enable, false);
  assert.deepEqual(
    payload.content.map((part) => part.type),
    ["text/plain", "text/html"],
  );
  assert.deepEqual(payload.from, {
    email: "sign@priviontech.com",
    name: "Privion",
  });
  assert.deepEqual(payload.reply_to, { email: "support@priviontech.com" });
  assert.equal(payload.attachments?.[0]?.content, "AQID");
  assert.deepEqual(payload.personalizations, [
    { to: [{ email: "casey@example.com" }] },
  ]);
});

test("a send returns SendGrid's message id, and a 429 is tried again", async () => {
  let calls = 0;
  const waits: number[] = [];
  const service = createSendGridEmailService({
    apiKey: "SG.key",
    fetchImpl: (async (_url: unknown, init?: RequestInit) => {
      calls += 1;
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer SG.key",
      );

      return calls === 1
        ? new Response(null, { status: 429 })
        : new Response(null, {
            headers: { "x-message-id": "abc123" },
            status: 202,
          });
    }) as typeof fetch,
    resolveAddresses: async () => ADDRESSES,
    wait: async (ms) => {
      waits.push(ms);
    },
  });

  const result = await service.send(MESSAGE);

  assert.equal(result.messageId, "abc123");
  assert.equal(calls, 2);
  assert.equal(waits.length, 1);
});

test("a refused send names SendGrid's reason", async () => {
  const service = createSendGridEmailService({
    apiKey: "SG.key",
    fetchImpl: (async () =>
      Response.json(
        {
          errors: [
            {
              field: "from",
              message:
                "The from address does not match a verified Sender Identity.",
            },
          ],
        },
        { status: 403 },
      )) as typeof fetch,
    resolveAddresses: async () => ADDRESSES,
    wait: async () => undefined,
  });

  await assert.rejects(service.send(MESSAGE), /verified Sender Identity/);
});

test("the domain check reads SendGrid's authenticated domains", async () => {
  const listing = (domains: unknown, status = 200) =>
    (async () => Response.json(domains, { status })) as typeof fetch;

  assert.deepEqual(
    await checkSendGridDomain(
      "priviontech.com",
      "k",
      listing([{ domain: "priviontech.com", valid: true }]),
    ),
    { result: "verified" },
  );
  assert.deepEqual(
    await checkSendGridDomain(
      "mail.priviontech.com",
      "k",
      listing([{ domain: "priviontech.com", valid: false }]),
    ),
    { result: "unverified" },
  );
  assert.deepEqual(await checkSendGridDomain("other.com", "k", listing([])), {
    result: "missing",
  });
  assert.deepEqual(await checkSendGridDomain("x.com", "k", listing({}, 403)), {
    result: "restricted",
  });
});
