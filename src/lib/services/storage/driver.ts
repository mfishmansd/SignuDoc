import { type EnvSource } from "../../utils/env.ts";

// Which storage the app uses. Kept free of the drivers themselves so the
// request proxy can ask without loading them.

export type StorageDriver = "blob" | "local" | "supabase";

/** True when a Vercel Blob store is connected to the project. */
export function hasBlobCredentials(env: EnvSource = process.env): boolean {
  return Boolean(
    env.BLOB_READ_WRITE_TOKEN?.trim() || env.BLOB_STORE_ID?.trim(),
  );
}

/** True when a Supabase project's Storage is configured for files. */
export function hasSupabaseStorageCredentials(
  env: EnvSource = process.env,
): boolean {
  return Boolean(
    env.SUPABASE_URL?.trim() && env.SUPABASE_SERVICE_ROLE_KEY?.trim(),
  );
}

/**
 * - "supabase": a private Supabase Storage bucket. Chosen automatically
 *   when SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set; the way to run
 *   on Netlify, where, as on Vercel, there is no disk to keep files on.
 * - "blob": Vercel Blob. Chosen automatically once a Blob store is connected
 *   to the project, and always on Vercel, where there is no disk to keep
 *   files on.
 * - "local": files on this machine's disk. The default everywhere else.
 *
 * STORAGE_DRIVER overrides the choice.
 */
export function resolveStorageDriver(
  env: EnvSource = process.env,
): StorageDriver {
  const configuredDriver = env.STORAGE_DRIVER?.trim().toLowerCase();

  if (
    configuredDriver === "blob" ||
    configuredDriver === "local" ||
    configuredDriver === "supabase"
  ) {
    return configuredDriver;
  }

  if (configuredDriver) {
    throw new Error(
      `Unknown STORAGE_DRIVER "${configuredDriver}". Use "blob", "local" or "supabase", or leave it unset.`,
    );
  }

  if (hasSupabaseStorageCredentials(env)) {
    return "supabase";
  }

  return hasBlobCredentials(env) || env.VERCEL === "1" ? "blob" : "local";
}

/**
 * True when the browser can send a PDF straight to storage instead of
 * through the app. Vercel caps a request to the app at 4.5 MB, far below the
 * upload limit, so on Vercel Blob this is the only way a larger PDF gets in.
 * Netlify caps it at 6 MB, so the same holds for Supabase Storage there.
 */
export function supportsDirectUploads(env: EnvSource = process.env): boolean {
  const driver = resolveStorageDriver(env);

  return driver === "blob" || driver === "supabase";
}
