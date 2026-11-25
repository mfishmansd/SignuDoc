import { type EnvSource, readEnv } from "../../utils/env.ts";
import { ServiceConfigurationError } from "../service-config.ts";
import {
  normalizeStorageKey,
  type StorageObjectHead,
  StorageObjectNotFoundError,
  type StorageService,
} from "./types.ts";

// Supabase Storage, in a private bucket: nothing in it has a public URL, and
// every read goes through the app, which checks who is asking first.
//
// Talks to the Storage REST API with plain fetch, so there is no SDK to
// bundle. The service role key never leaves the server.
// https://supabase.com/docs/reference/api/storage

const DEFAULT_BUCKET = "signudoc";

export type SupabaseStorageConfig = {
  bucket: string;
  serviceRoleKey: string;
  /** The project URL, such as https://abc.supabase.co, with no trailing slash. */
  url: string;
};

export function readSupabaseStorageConfig(
  env: EnvSource = process.env,
): SupabaseStorageConfig {
  const url = readEnv(env, "SUPABASE_URL");
  const serviceRoleKey = readEnv(env, "SUPABASE_SERVICE_ROLE_KEY");

  if (!url || !serviceRoleKey) {
    throw new ServiceConfigurationError("storage", [
      ...(url ? [] : ["SUPABASE_URL"]),
      ...(serviceRoleKey ? [] : ["SUPABASE_SERVICE_ROLE_KEY"]),
    ]);
  }

  return {
    bucket: readEnv(env, "SUPABASE_STORAGE_BUCKET") ?? DEFAULT_BUCKET,
    serviceRoleKey,
    url: url.replace(/\/+$/, ""),
  };
}

/** The key as a URL path, each segment encoded on its own. */
function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

function objectUrl(
  config: SupabaseStorageConfig,
  key: string,
  kind: "authenticated" | "plain" = "plain",
): string {
  const scope = kind === "authenticated" ? "authenticated/" : "";

  return `${config.url}/storage/v1/object/${scope}${encodeURIComponent(config.bucket)}/${encodeKey(key)}`;
}

function authHeaders(config: SupabaseStorageConfig): Record<string, string> {
  return {
    apikey: config.serviceRoleKey,
    authorization: `Bearer ${config.serviceRoleKey}`,
  };
}

// Storage answers a missing object with 404, or on older versions with 400
// and {"statusCode": "404"} in the body.
async function isNotFound(response: Response): Promise<boolean> {
  if (response.status === 404) {
    return true;
  }

  if (response.status !== 400) {
    return false;
  }

  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as { error?: string; statusCode?: string } | null;

  return (
    body?.statusCode === "404" ||
    body?.error === "not_found" ||
    body?.error === "Not found"
  );
}

async function storageError(
  action: string,
  key: string,
  response: Response,
): Promise<Error> {
  const detail = await response.text().catch(() => "");

  return new Error(
    `Supabase Storage ${action} failed for ${key}: ${String(response.status)} ${detail.slice(0, 300)}`,
  );
}

type CreateSupabaseStorageServiceOptions = {
  env?: EnvSource;
  /** Replaced in tests. */
  fetchImpl?: typeof fetch;
};

export function createSupabaseStorageService({
  env = process.env,
  fetchImpl = fetch,
}: CreateSupabaseStorageServiceOptions = {}): StorageService {
  const config = readSupabaseStorageConfig(env);
  const bucketName = `supabase:${config.bucket}`;

  async function fetchObject(key: string) {
    const normalizedKey = normalizeStorageKey(key);
    const response = await fetchImpl(
      objectUrl(config, normalizedKey, "authenticated"),
      // A signed PDF or certificate can be written again under the same key,
      // so never take a cached copy.
      { cache: "no-store", headers: authHeaders(config) },
    );

    if (!response.ok) {
      if (await isNotFound(response)) {
        throw new StorageObjectNotFoundError(normalizedKey);
      }

      throw await storageError("download", normalizedKey, response);
    }

    return { normalizedKey, response };
  }

  async function headObject(key: string): Promise<StorageObjectHead> {
    const normalizedKey = normalizeStorageKey(key);
    const response = await fetchImpl(
      objectUrl(config, normalizedKey, "authenticated"),
      { cache: "no-store", headers: authHeaders(config), method: "HEAD" },
    );

    // A HEAD answer has no body to say why, so any 4xx means not there.
    if (response.status >= 400 && response.status < 500) {
      return { bucketName, exists: false, key: normalizedKey };
    }

    if (!response.ok) {
      throw await storageError("head", normalizedKey, response);
    }

    const length = response.headers.get("content-length");

    return {
      bucketName,
      contentLength: length ? Number(length) : undefined,
      contentType: response.headers.get("content-type") ?? undefined,
      etag: response.headers.get("etag") ?? undefined,
      exists: true,
      key: normalizedKey,
    };
  }

  return {
    async deleteObject(key) {
      const normalizedKey = normalizeStorageKey(key);
      // Deleting something already gone succeeds, as with the other drivers.
      const response = await fetchImpl(
        `${config.url}/storage/v1/object/${encodeURIComponent(config.bucket)}`,
        {
          body: JSON.stringify({ prefixes: [normalizedKey] }),
          headers: {
            ...authHeaders(config),
            "content-type": "application/json",
          },
          method: "DELETE",
        },
      );

      if (!response.ok && !(await isNotFound(response))) {
        throw await storageError("delete", normalizedKey, response);
      }
    },
    async getObject(key) {
      const { normalizedKey, response } = await fetchObject(key);
      const body = new Uint8Array(await response.arrayBuffer());

      return {
        body,
        bucketName,
        contentLength: body.byteLength,
        contentType: response.headers.get("content-type") ?? undefined,
        etag: response.headers.get("etag") ?? undefined,
        key: normalizedKey,
      };
    },
    async getObjectStream(key) {
      const { normalizedKey, response } = await fetchObject(key);

      if (!response.body) {
        throw new StorageObjectNotFoundError(normalizedKey);
      }

      const length = response.headers.get("content-length");

      return {
        bucketName,
        contentLength: length ? Number(length) : undefined,
        contentType: response.headers.get("content-type") ?? undefined,
        key: normalizedKey,
        stream: response.body,
      };
    },
    headObject,
    async putObject(input) {
      const normalizedKey = normalizeStorageKey(input.key);
      // x-upsert: false makes Storage itself refuse a second write to the
      // same key, so of two writers that arrive together exactly one is kept.
      const response = await fetchImpl(objectUrl(config, normalizedKey), {
        body: new Blob([input.body as Uint8Array<ArrayBuffer>]),
        headers: {
          ...authHeaders(config),
          "cache-control": "no-cache",
          "content-type": input.contentType,
          "x-upsert": input.keepExisting ? "false" : "true",
        },
        method: "POST",
      });

      if (!response.ok) {
        // As with Blob: an object that is already there is what was asked
        // for. Any other failure is still a failure.
        if (!input.keepExisting || !(await headObject(normalizedKey)).exists) {
          throw await storageError("upload", normalizedKey, response);
        }
      }

      return { bucketName, key: normalizedKey };
    },
  };
}

export type SignedUpload = {
  expiresAt: string;
  headers: Record<string, string>;
  method: "PUT";
  url: string;
};

// Supabase decides how long a signed upload URL lasts (two hours); it
// cannot be shortened. The app still treats the upload as untrusted and
// validates the PDF when it is picked up.
const SIGNED_UPLOAD_LIFETIME_MS = 2 * 60 * 60 * 1000;

/**
 * A URL a browser or API caller can PUT one PDF to, without the app in
 * between. Good for this key only, and refused if something is already
 * stored there. The bucket's own size and type limits apply.
 */
export async function createSupabaseSignedUpload(
  key: string,
  {
    env = process.env,
    fetchImpl = fetch,
    now = Date.now(),
  }: CreateSupabaseStorageServiceOptions & { now?: number } = {},
): Promise<SignedUpload> {
  const config = readSupabaseStorageConfig(env);
  const normalizedKey = normalizeStorageKey(key);
  const response = await fetchImpl(
    `${config.url}/storage/v1/object/upload/sign/${encodeURIComponent(config.bucket)}/${encodeKey(normalizedKey)}`,
    {
      headers: { ...authHeaders(config), "x-upsert": "false" },
      method: "POST",
    },
  );

  if (!response.ok) {
    throw await storageError("signed upload", normalizedKey, response);
  }

  const { url } = (await response.json()) as { url?: string };

  if (!url) {
    throw new Error("Supabase Storage returned no signed upload URL.");
  }

  return {
    expiresAt: new Date(now + SIGNED_UPLOAD_LIFETIME_MS).toISOString(),
    headers: { "content-type": "application/pdf", "x-upsert": "false" },
    method: "PUT",
    url: `${config.url}/storage/v1${url.startsWith("/") ? "" : "/"}${url}`,
  };
}

type ListedItem = {
  created_at?: string | null;
  id: string | null;
  name: string;
};

/**
 * Deletes PDFs a browser or API caller uploaded but the app never picked up
 * (a closed tab, a failed request). Vercel Blob does this by itself after a
 * day; Supabase Storage needs to be asked. Returns how many were deleted.
 */
export async function sweepAbandonedSupabaseUploads({
  env = process.env,
  fetchImpl = fetch,
  now = Date.now(),
  olderThanMs = 24 * 60 * 60 * 1000,
  prefix,
}: CreateSupabaseStorageServiceOptions & {
  now?: number;
  olderThanMs?: number;
  /** The pending uploads root, such as "pending". */
  prefix: string;
}): Promise<number> {
  const config = readSupabaseStorageConfig(env);
  const service = createSupabaseStorageService({ env, fetchImpl });

  async function list(path: string): Promise<ListedItem[]> {
    const items: ListedItem[] = [];

    for (let offset = 0; ; offset += 1000) {
      const response = await fetchImpl(
        `${config.url}/storage/v1/object/list/${encodeURIComponent(config.bucket)}`,
        {
          body: JSON.stringify({ limit: 1000, offset, prefix: path }),
          headers: {
            ...authHeaders(config),
            "content-type": "application/json",
          },
          method: "POST",
        },
      );

      if (!response.ok) {
        throw await storageError("list", path, response);
      }

      const page = (await response.json()) as ListedItem[];

      items.push(...page);

      if (page.length < 1000) {
        return items;
      }
    }
  }

  const root = prefix.replace(/\/+$/, "");
  let deleted = 0;

  // Pending uploads are <root>/<userId>/<uuid>.pdf: folders, then files.
  for (const folder of await list(root)) {
    if (folder.id !== null) {
      continue;
    }

    for (const file of await list(`${root}/${folder.name}`)) {
      const createdAt = file.created_at ? Date.parse(file.created_at) : NaN;

      if (file.id === null || !(now - createdAt > olderThanMs)) {
        continue;
      }

      await service.deleteObject(`${root}/${folder.name}/${file.name}`);
      deleted += 1;
    }
  }

  return deleted;
}
