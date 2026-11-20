import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(resolve(root, "src/lib/velora/i18n.ts"), "utf8");

function catalog(start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `Missing catalog: ${start}`);
  const to = source.indexOf(end, from);
  assert.notEqual(to, -1, `Missing catalog end: ${end}`);
  const body = source.slice(from, to);
  return new Map(
    [...body.matchAll(/\b([A-Za-z_]\w*)\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => [
      m[1],
      { value: m[2], placeholders: [...m[2].matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort() },
    ]),
  );
}

test("all language catalogs have the same keys and interpolation placeholders", () => {
  const en = catalog("const en = {", "\n};");
  const catalogs = [
    catalog("const fa:", "\n};"),
    catalog("const ru:", "\n};"),
    catalog("const ar:", "\n};"),
  ];
  for (const localized of catalogs) {
    assert.deepEqual([...localized.keys()].sort(), [...en.keys()].sort());
    for (const [key, base] of en) {
      assert.ok(localized.get(key).value.length > 0, `Empty translation: ${key}`);
      assert.deepEqual(localized.get(key).placeholders, base.placeholders, `Placeholder mismatch: ${key}`);
    }
  }
});

test("Russian and Arabic are included in the supported language type", () => {
  assert.match(source, /export type Lang = "en" \| "fa" \| "ru" \| "ar"/);
});
