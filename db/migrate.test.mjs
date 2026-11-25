import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveMigrationSchema, retargetMigrationSql } from "./migrate.mjs";

test("migrations go into public unless DATABASE_SCHEMA names another schema", () => {
  assert.equal(resolveMigrationSchema({}), "public");
  assert.equal(
    resolveMigrationSchema({ DATABASE_SCHEMA: " signudoc " }),
    "signudoc",
  );
  assert.throws(() => resolveMigrationSchema({ DATABASE_SCHEMA: "x; drop" }));
});

test("schema-qualified names move to the schema; prose and public alone do not", () => {
  const sql = [
    "-- API keys for the public API (/api/v1).",
    'create table public.api_keys (user_id text references public."user"(id));',
    "create or replace function public.clear_reason() returns trigger as $$ begin end $$;",
  ].join("\n");

  assert.equal(
    retargetMigrationSql(sql, "signudoc"),
    [
      "-- API keys for the public API (/api/v1).",
      'create table signudoc.api_keys (user_id text references signudoc."user"(id));',
      "create or replace function signudoc.clear_reason() returns trigger as $$ begin end $$;",
    ].join("\n"),
  );
  assert.equal(retargetMigrationSql(sql, "public"), sql);
});
