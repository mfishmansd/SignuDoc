import assert from "node:assert/strict";
import { test } from "node:test";

import { ServiceConfigurationError } from "../service-config.ts";
import { resolveStorageDriver, supportsDirectUploads } from "./driver.ts";
import {
  createSupabaseSignedUpload,
  createSupabaseStorageService,
  sweepAbandonedSupabaseUploads,
} from "./supabase.ts";
import { StorageObjectNotFoundError } from "./types.ts";

const ENV = {
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
  SUPABASE_URL: "https://project.supabase.co/",
};
const OBJECT_ROOT = "https://project.supabase.co/storage/v1/object";

type Stored = { body: Uint8Array; contentType: string; createdAt: string };

// An in-memory stand-in for the Storage REST API, enough of it for the
// driver: upload (with x-upsert), download, HEAD, delete, list and signing.
function createFakeStorage() {
  const objects = new Map<string, Stored>();
  const requests: Array<{ headers: Headers; method: string; url: string }> = [];

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);

    requests.push({ headers, method, url });
    assert.equal(headers.get("authorization"), "Bearer service-key");

    const path = decodeURIComponent(url.slice(OBJECT_ROOT.length + 1));

    if (path.startsWith("upload/sign/")) {
      return Response.json({
        url: `/object/upload/sign/${path.slice("upload/sign/".length)}?token=t`,
      });
    }

    if (path.startsWith("list/")) {
      const { prefix } = JSON.parse(String(init?.body)) as { prefix: string };
      const children = new Map<
        string,
        { created_at?: string; id: string | null }
      >();

      for (const [key, value] of objects) {
        const fullKey = key.slice("signudoc/".length);

        if (!fullKey.startsWith(`${prefix}/`)) {
          continue;
        }

        const [first, ...rest] = fullKey.slice(prefix.length + 1).split("/");

        children.set(
          first,
          rest.length > 0
            ? { id: null }
            : { created_at: value.createdAt, id: "file" },
        );
      }

      return Response.json(
        [...children].map(([name, item]) => ({ name, ...item })),
      );
    }

    if (method === "DELETE") {
      const { prefixes } = JSON.parse(String(init?.body)) as {
        prefixes: string[];
      };

      for (const key of prefixes) {
        objects.delete(`${path}/${key}`);
      }

      return Response.json([]);
    }

    if (method === "POST") {
      if (headers.get("x-upsert") === "false" && objects.has(path)) {
        return Response.json(
          { error: "Duplicate", statusCode: "409" },
          { status: 400 },
        );
      }

      objects.set(path, {
        body: new Uint8Array(await new Response(init?.body).arrayBuffer()),
        contentType: headers.get("content-type") ?? "",
        createdAt: new Date().toISOString(),
      });

      return Response.json({ Key: path });
    }

    const stored = objects.get(path.replace(/^authenticated\//, ""));

    if (!stored) {
      return method === "HEAD"
        ? new Response(null, { status: 400 })
        : Response.json(
            { error: "not_found", statusCode: "404" },
            { status: 400 },
          );
    }

    return new Response(
      method === "HEAD"
        ? null
        : new Blob([stored.body as Uint8Array<ArrayBuffer>]),
      {
        headers: {
          "content-length": String(stored.body.byteLength),
          "content-type": stored.contentType,
          etag: '"etag"',
        },
      },
    );
  }) as typeof fetch;

  return { fetchImpl, objects, requests };
}

test("Supabase is chosen when its URL and service key are set, and allows direct uploads", () => {
  assert.equal(resolveStorageDriver(ENV), "supabase");
  assert.equal(supportsDirectUploads(ENV), true);
  assert.equal(
    resolveStorageDriver({ ...ENV, STORAGE_DRIVER: "local" }),
    "local",
  );
  assert.equal(
    resolveStorageDriver({ SUPABASE_URL: ENV.SUPABASE_URL }),
    "local",
  );
});

test("without a service key the driver says what is missing", () => {
  assert.throws(
    () => createSupabaseStorageService({ env: { SUPABASE_URL: "https://x" } }),
    ServiceConfigurationError,
  );
});

test("objects round-trip, stream, and report their size", async () => {
  const fake = createFakeStorage();
  const storage = createSupabaseStorageService({
    env: ENV,
    fetchImpl: fake.fetchImpl,
  });

  await storage.putObject({
    body: new Uint8Array([1, 2, 3]),
    contentType: "application/pdf",
    key: "envelopes/a b/original.pdf",
  });

  assert.ok(fake.objects.has("signudoc/envelopes/a b/original.pdf"));

  const object = await storage.getObject("envelopes/a b/original.pdf");

  assert.deepEqual([...object.body], [1, 2, 3]);
  assert.equal(object.contentType, "application/pdf");

  const head = await storage.headObject("envelopes/a b/original.pdf");

  assert.equal(head.exists, true);
  assert.equal(head.contentLength, 3);

  const stream = await storage.getObjectStream("envelopes/a b/original.pdf");

  assert.equal((await new Response(stream.stream).arrayBuffer()).byteLength, 3);
});

test("missing objects are not found, and deleting one is not an error", async () => {
  const fake = createFakeStorage();
  const storage = createSupabaseStorageService({
    env: ENV,
    fetchImpl: fake.fetchImpl,
  });

  await assert.rejects(
    storage.getObject("nothing.pdf"),
    StorageObjectNotFoundError,
  );
  assert.equal((await storage.headObject("nothing.pdf")).exists, false);
  await storage.deleteObject("nothing.pdf");
});

test("keepExisting leaves the first write in place; a plain write replaces it", async () => {
  const fake = createFakeStorage();
  const storage = createSupabaseStorageService({
    env: ENV,
    fetchImpl: fake.fetchImpl,
  });
  const write = (byte: number, keepExisting?: boolean) =>
    storage.putObject({
      body: new Uint8Array([byte]),
      contentType: "application/pdf",
      keepExisting,
      key: "k.pdf",
    });

  await write(1, true);
  await write(2, true);
  assert.deepEqual([...(await storage.getObject("k.pdf")).body], [1]);

  await write(3);
  assert.deepEqual([...(await storage.getObject("k.pdf")).body], [3]);
});

test("a signed upload is a PUT to the project's signed URL that will not overwrite", async () => {
  const fake = createFakeStorage();
  const upload = await createSupabaseSignedUpload("uploads/u1/x.pdf", {
    env: ENV,
    fetchImpl: fake.fetchImpl,
    now: 0,
  });

  assert.equal(upload.method, "PUT");
  assert.equal(
    upload.url,
    "https://project.supabase.co/storage/v1/object/upload/sign/signudoc/uploads/u1/x.pdf?token=t",
  );
  assert.equal(upload.headers["x-upsert"], "false");
  assert.equal(fake.requests[0]?.headers.get("x-upsert"), "false");
});

test("the sweep deletes only pending uploads older than a day", async () => {
  const fake = createFakeStorage();
  const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const fresh = new Date().toISOString();
  const body = new Uint8Array([1]);

  fake.objects.set("signudoc/uploads/u1/old.pdf", {
    body,
    contentType: "",
    createdAt: old,
  });
  fake.objects.set("signudoc/uploads/u1/new.pdf", {
    body,
    contentType: "",
    createdAt: fresh,
  });
  fake.objects.set("signudoc/envelopes/e1/original.pdf", {
    body,
    contentType: "",
    createdAt: old,
  });

  const deleted = await sweepAbandonedSupabaseUploads({
    env: ENV,
    fetchImpl: fake.fetchImpl,
    prefix: "uploads",
  });

  assert.equal(deleted, 1);
  assert.deepEqual([...fake.objects.keys()].sort(), [
    "signudoc/envelopes/e1/original.pdf",
    "signudoc/uploads/u1/new.pdf",
  ]);
});
