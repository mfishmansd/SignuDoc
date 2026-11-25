import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

// Tables can live in a schema other than public (DATABASE_SCHEMA, see
// docs/netlify-supabase.md), found through the role's search_path. A query
// that names public would miss them, so app code must not. Catches one
// arriving in an upstream merge.

const SOURCE_ROOT = path.resolve(import.meta.dirname, "../..");
const QUALIFIED = /\bpublic\.("[A-Za-z_]+"|[a-z_]+)\b/;

async function* sourceFiles(directory: string): AsyncGenerator<string> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      yield* sourceFiles(fullPath);
    } else if (
      /\.tsx?$/.test(entry.name) &&
      !/\.(test|dbtest)\.tsx?$/.test(entry.name)
    ) {
      yield fullPath;
    }
  }
}

test("app code names no table by the public schema", async () => {
  const offenders: string[] = [];

  for await (const file of sourceFiles(SOURCE_ROOT)) {
    const lines = (await readFile(file, "utf8")).split("\n");

    lines.forEach((line, index) => {
      if (QUALIFIED.test(line)) {
        offenders.push(
          `${path.relative(SOURCE_ROOT, file)}:${String(index + 1)}`,
        );
      }
    });
  }

  assert.deepEqual(offenders, []);
});
