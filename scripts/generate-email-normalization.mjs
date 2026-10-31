// Pin the Unicode tables used by production Node's trim().toLowerCase().
// Regeneration is a schema change: existing normalized indexes need revalidation.
import fs from 'node:fs';

if (process.versions.unicode !== '17.0') throw new Error('Use Node with Unicode 17.0; changing Unicode requires a new migration');
const file = new URL('../server/src/db/migrations/595_normalized_email_invariant.sql', import.meta.url);
const quote = value => `'${value.replaceAll("'", "''")}'`;
let upper = '', lower = '', whitespace = '';
const cased = [], ignorable = [];
for (let n = 1; n <= 0x10ffff; n++) {
  if (n >= 0xd800 && n <= 0xdfff) continue;
  const ch = String.fromCodePoint(n), mapped = ch.toLowerCase();
  if (ch.trim() === '') whitespace += ch;
  if (/\p{Cased}/u.test(ch)) cased.push(n);
  if (/\p{Case_Ignorable}/u.test(ch)) ignorable.push(n);
  if (mapped !== ch && n !== 0x130) {
    if ([...mapped].length !== 1) throw new Error(`Unexpected full lowercase mapping: ${n}`);
    upper += ch; lower += mapped;
  }
}
// Numeric ranges avoid locale-sensitive PostgreSQL regular-expression ranges.
function ranges(points) {
  const result = [];
  for (const n of points) {
    const last = result.at(-1);
    if (last && last[1] === n) last[1] = n + 1;
    else result.push([n, n + 1]);
  }
  return `'{${result.map(([a,b]) => `[${a},${b})`).join(',')}}'::pg_catalog.int4multirange`;
}
const generated = `-- BEGIN GENERATED NORMALIZATION (Unicode 17.0; scripts/generate-email-normalization.mjs)
CREATE OR REPLACE FUNCTION public.normalized_credential_email(value TEXT)
RETURNS TEXT LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog
AS $normalize$
DECLARE
  original TEXT := pg_catalog.btrim(value, ${[...whitespace].map(ch => `pg_catalog.chr(${ch.codePointAt(0)})`).join(' || ')});
  result TEXT := '';
  ch TEXT;
  mapped TEXT;
  point INTEGER;
  position INTEGER;
  following INTEGER;
  previous_cased BOOLEAN := FALSE;
  next_cased BOOLEAN;
  cased CONSTANT pg_catalog.int4multirange := ${ranges(cased)};
  ignorable CONSTANT pg_catalog.int4multirange := ${ranges(ignorable)};
BEGIN
  -- Locale-independent ASCII fast path (the usual production address).
  IF pg_catalog.octet_length(original) = pg_catalog.char_length(original) THEN
    RETURN pg_catalog.translate(original, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz');
  END IF;
  FOR position IN 1..pg_catalog.char_length(original) LOOP
    ch := pg_catalog.substr(original, position, 1);
    point := pg_catalog.ascii(ch);
    IF point = 931 AND previous_cased THEN
      next_cased := FALSE;
      FOR following IN position + 1..pg_catalog.char_length(original) LOOP
        point := pg_catalog.ascii(pg_catalog.substr(original, following, 1));
        IF ignorable @> point THEN CONTINUE; END IF;
        next_cased := cased @> point;
        EXIT;
      END LOOP;
      mapped := CASE WHEN next_cased THEN 'σ' ELSE 'ς' END;
    ELSIF point = 304 THEN
      mapped := U&'i\\0307';
    ELSE
      mapped := pg_catalog.translate(ch, ${quote(upper)}, ${quote(lower)});
    END IF;
    result := result || mapped;
    point := pg_catalog.ascii(ch);
    IF NOT (ignorable @> point) THEN previous_cased := cased @> point; END IF;
  END LOOP;
  RETURN result;
END;
$normalize$;
-- END GENERATED NORMALIZATION`;
const source = fs.readFileSync(file, 'utf8');
const output = source.replace(/-- BEGIN GENERATED NORMALIZATION[\s\S]*?-- END GENERATED NORMALIZATION/, generated);
if (process.argv.includes('--check')) {
  if (output !== source) throw new Error('Migration 595 normalization differs from production Node Unicode tables');
  console.log('Email normalization Unicode 17.0 generator check passed');
} else fs.writeFileSync(file, output);
