-- ============================================================================
-- SQLite-compatible functions for PostgreSQL.
--
-- The CRM's SQL was written for SQLite. The translator (pg/translate.js)
-- rewrites SQLite-only calls to these functions, which return exactly what
-- SQLite returns, in the same text formats:
--
--   date(...)      -> s_date(...)       'YYYY-MM-DD'
--   datetime(...)  -> s_datetime(...)   'YYYY-MM-DD HH:MM:SS'
--   time(...)      -> s_time(...)       'HH:MM:SS'
--   julianday(...) -> s_julianday(...)  fractional day number
--   strftime(...)  -> s_strftime(...)
--   CAST(x AS INTEGER) -> s_int(x)      truncates, text prefix, never errors
--   CAST(x AS REAL)    -> s_real(x)
--
-- Dates are stored as TEXT, exactly as they were in SQLite, so every
-- comparison and sort behaves the same. 'now' is UTC, as in SQLite.
-- Invalid input returns NULL instead of raising an error, as in SQLite.
--
-- Installed (CREATE OR REPLACE) every time the server starts; safe to rerun.
-- ============================================================================

-- Parse a SQLite time value and apply modifiers. Returns a UTC timestamp.
CREATE OR REPLACE FUNCTION s_ts(val text, mods text[] DEFAULT '{}') RETURNS timestamp
LANGUAGE plpgsql STABLE AS $f$
DECLARE
  t timestamp;
  v text;
  m text;
  n double precision;
  unit text;
  y int; mo int; d int; k int; wd int; hh int; mi int; ss numeric;
  parts text[];
  numeric_input boolean := false;
BEGIN
  IF val IS NULL THEN RETURN NULL; END IF;
  v := btrim(val);
  BEGIN
    IF lower(v) = 'now' THEN
      t := statement_timestamp() AT TIME ZONE 'UTC';
    ELSIF v ~* '^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?\s*(z|[+-]\d{2}:?\d{2})?$' THEN
      -- Read the parts as SQLite does: month 1-12, day 1-31 (a day past
      -- the month's end rolls over: Feb 30 -> Mar 2), hour 0-24,
      -- minute and second 0-59. Anything else is NULL, never an error.
      parts := regexp_match(v, '^(\d{4})-(\d{2})-(\d{2})(?:[ Tt](\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?\s*([zZ]|[+-]\d{2}:?\d{2})?$');
      y := parts[1]::int; mo := parts[2]::int; d := parts[3]::int;
      hh := COALESCE(parts[4], '0')::int; mi := COALESCE(parts[5], '0')::int; ss := COALESCE(parts[6], '0')::numeric;
      IF mo < 1 OR mo > 12 OR d < 1 OR d > 31 OR hh > 24 OR mi > 59 OR ss >= 60 THEN RETURN NULL; END IF;
      t := make_date(y, mo, 1) + (d - 1) * interval '1 day' + hh * interval '1 hour' + mi * interval '1 minute' + ss * interval '1 second';
      IF parts[7] IS NOT NULL AND upper(parts[7]) <> 'Z' THEN
        -- '+05:30' means local time 5h30 ahead of UTC: subtract it
        t := t - (CASE WHEN left(parts[7], 1) = '-' THEN -1 ELSE 1 END)
               * (substr(replace(parts[7], ':', ''), 2, 2)::int * interval '1 hour' + substr(replace(parts[7], ':', ''), 4, 2)::int * interval '1 minute');
      END IF;
    ELSIF v ~ '^\d{2}:\d{2}(:\d{2}(\.\d+)?)?$' THEN
      parts := regexp_match(v, '^(\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?$');
      hh := parts[1]::int; mi := parts[2]::int; ss := COALESCE(parts[3], '0')::numeric;
      IF hh > 24 OR mi > 59 OR ss >= 60 THEN RETURN NULL; END IF;
      t := timestamp '2000-01-01' + hh * interval '1 hour' + mi * interval '1 minute' + ss * interval '1 second';
    ELSIF v ~ '^-?\d+(\.\d+)?$' THEN
      numeric_input := true;
      t := to_timestamp((v::double precision - 2440587.5) * 86400) AT TIME ZONE 'UTC';
    ELSE
      RETURN NULL;
    END IF;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;

  IF mods IS NULL THEN RETURN t; END IF;
  FOREACH m IN ARRAY mods LOOP
    IF m IS NULL THEN RETURN NULL; END IF;
    m := lower(btrim(m));
    IF m ~ '^[+-]?\d+(\.\d+)?\s*(day|hour|minute|second|month|year)s?$' THEN
      n := substring(m from '^[+-]?\d+(?:\.\d+)?')::double precision;
      unit := substring(m from '(day|hour|minute|second|month|year)');
      IF unit IN ('month', 'year') THEN
        -- SQLite adds to the month number and lets the day overflow into the
        -- next month (Jan 31 + 1 month = Mar 3), unlike PostgreSQL intervals.
        k := CASE unit WHEN 'month' THEN trunc(n)::int ELSE trunc(n)::int * 12 END;
        y := extract(year from t)::int; mo := extract(month from t)::int; d := extract(day from t)::int;
        mo := mo - 1 + k;
        y := y + floor(mo / 12.0)::int;
        mo := mo - floor(mo / 12.0)::int * 12 + 1;
        t := make_date(y, mo, 1) + (d - 1) * interval '1 day' + (t - date_trunc('day', t));
      ELSE
        t := t + n * ('1 ' || unit)::interval;
      END IF;
    ELSIF m ~ '^[+-]\d{2}:\d{2}(:\d{2})?$' THEN
      t := t + (CASE WHEN left(m, 1) = '-' THEN -1 ELSE 1 END) * substr(m, 2)::interval;
    ELSIF m = 'start of day' THEN t := date_trunc('day', t);
    ELSIF m = 'start of month' THEN t := date_trunc('month', t);
    ELSIF m = 'start of year' THEN t := date_trunc('year', t);
    ELSIF m ~ '^weekday [0-6]$' THEN
      wd := right(m, 1)::int;
      t := t + ((wd - extract(dow from t)::int + 7) % 7) * interval '1 day';
    ELSIF m = 'localtime' THEN
      t := (t AT TIME ZONE 'UTC') AT TIME ZONE current_setting('TimeZone');
    ELSIF m = 'utc' THEN
      t := (t AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE 'UTC';
    ELSIF m = 'unixepoch' AND numeric_input THEN
      t := to_timestamp(v::double precision) AT TIME ZONE 'UTC';
    ELSE
      RETURN NULL;
    END IF;
  END LOOP;
  RETURN t;
END
$f$;

-- ---- Fast path -------------------------------------------------------------
-- The common cases are handled in plain SQL (fast): a stored date or
-- date-time with no timezone suffix, 'now', and at most one modifier in
-- days / hours / minutes / seconds. Everything else goes to s_ts() above.
CREATE OR REPLACE FUNCTION s_tsf(val text, mods text[]) RETURNS timestamp
LANGUAGE sql STABLE AS $f$
  SELECT CASE
    WHEN val IS NULL THEN NULL
    WHEN cardinality(mods) = 0 AND val ~ '^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|1\d|2[0-8])([ T]([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?)?$'
      THEN replace(val, 'T', ' ')::timestamp
    WHEN cardinality(mods) = 0 AND lower(val) = 'now'
      THEN statement_timestamp() AT TIME ZONE 'UTC'
    WHEN cardinality(mods) = 1 AND mods[1] ~* '^\s*[+-]?\d+(\.\d+)?\s*(day|hour|minute|second)s?\s*$'
         AND val ~ '^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|1\d|2[0-8])([ T]([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?)?$'
      THEN replace(val, 'T', ' ')::timestamp + btrim(mods[1])::interval
    WHEN cardinality(mods) = 1 AND mods[1] ~* '^\s*[+-]?\d+(\.\d+)?\s*(day|hour|minute|second)s?\s*$' AND lower(val) = 'now'
      THEN (statement_timestamp() AT TIME ZONE 'UTC') + btrim(mods[1])::interval
    ELSE s_ts(val, mods)
  END
$f$;

-- ---- date() ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION s_date(val text, VARIADIC mods text[] DEFAULT '{}') RETURNS text
LANGUAGE sql STABLE AS $f$
  SELECT CASE
    WHEN cardinality(mods) = 0 AND val ~ '^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|1\d|2[0-8])([ T]([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?)?$' THEN substr(val, 1, 10)
    ELSE to_char(s_tsf(val, mods), 'YYYY-MM-DD')
  END
$f$;
CREATE OR REPLACE FUNCTION s_date(val double precision, VARIADIC mods text[] DEFAULT '{}') RETURNS text
LANGUAGE sql STABLE AS $f$ SELECT s_date(val::text, VARIADIC mods) $f$;

-- ---- datetime() -----------------------------------------------------------
CREATE OR REPLACE FUNCTION s_datetime(val text, VARIADIC mods text[] DEFAULT '{}') RETURNS text
LANGUAGE sql STABLE AS $f$
  SELECT CASE
    WHEN cardinality(mods) = 0 AND val ~ '^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|1\d|2[0-8]) ([01]\d|2[0-3]):[0-5]\d:[0-5]\d$' THEN val
    ELSE to_char(s_tsf(val, mods), 'YYYY-MM-DD HH24:MI:SS')
  END
$f$;
CREATE OR REPLACE FUNCTION s_datetime(val double precision, VARIADIC mods text[] DEFAULT '{}') RETURNS text
LANGUAGE sql STABLE AS $f$ SELECT s_datetime(val::text, VARIADIC mods) $f$;

-- ---- time() ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION s_time(val text, VARIADIC mods text[] DEFAULT '{}') RETURNS text
LANGUAGE sql STABLE AS $f$ SELECT to_char(s_tsf(val, mods), 'HH24:MI:SS') $f$;

-- ---- julianday() ----------------------------------------------------------
CREATE OR REPLACE FUNCTION s_julianday(val text, VARIADIC mods text[] DEFAULT '{}') RETURNS double precision
LANGUAGE sql STABLE AS $f$ SELECT extract(epoch from s_tsf(val, mods))::double precision / 86400.0 + 2440587.5 $f$;
CREATE OR REPLACE FUNCTION s_julianday(val double precision, VARIADIC mods text[] DEFAULT '{}') RETURNS double precision
LANGUAGE sql STABLE AS $f$ SELECT s_julianday(val::text, VARIADIC mods) $f$;

-- ---- strftime() -----------------------------------------------------------
CREATE OR REPLACE FUNCTION s_strftime(fmt text, val text, VARIADIC mods text[] DEFAULT '{}') RETURNS text
LANGUAGE plpgsql STABLE AS $f$
DECLARE
  t timestamp := s_tsf(val, mods);
  out text := '';
  i int := 1;
  c text;
  yday int; wday_mon int;
BEGIN
  IF t IS NULL OR fmt IS NULL THEN RETURN NULL; END IF;
  WHILE i <= length(fmt) LOOP
    c := substr(fmt, i, 1);
    IF c = '%' AND i < length(fmt) THEN
      i := i + 1;
      c := substr(fmt, i, 1);
      CASE c
        WHEN 'd' THEN out := out || to_char(t, 'DD');
        WHEN 'e' THEN out := out || lpad(extract(day from t)::int::text, 2, ' ');
        WHEN 'f' THEN out := out || to_char(t, 'SS.MS');
        WHEN 'H' THEN out := out || to_char(t, 'HH24');
        WHEN 'I' THEN out := out || to_char(t, 'HH12');
        WHEN 'j' THEN out := out || to_char(t, 'DDD');
        WHEN 'J' THEN out := out || (extract(epoch from t) / 86400.0 + 2440587.5)::text;
        WHEN 'm' THEN out := out || to_char(t, 'MM');
        WHEN 'M' THEN out := out || to_char(t, 'MI');
        WHEN 's' THEN out := out || floor(extract(epoch from t))::bigint::text;
        WHEN 'S' THEN out := out || to_char(t, 'SS');
        WHEN 'w' THEN out := out || extract(dow from t)::int::text;
        WHEN 'u' THEN out := out || extract(isodow from t)::int::text;
        WHEN 'W' THEN
          yday := extract(doy from t)::int - 1;
          wday_mon := (extract(dow from t)::int + 6) % 7;
          out := out || lpad(((yday + 7 - wday_mon) / 7)::text, 2, '0');
        WHEN 'Y' THEN out := out || to_char(t, 'YYYY');
        WHEN 'F' THEN out := out || to_char(t, 'YYYY-MM-DD');
        WHEN 'T' THEN out := out || to_char(t, 'HH24:MI:SS');
        WHEN 'R' THEN out := out || to_char(t, 'HH24:MI');
        WHEN '%' THEN out := out || '%';
        ELSE RETURN NULL;
      END CASE;
    ELSE
      out := out || c;
    END IF;
    i := i + 1;
  END LOOP;
  RETURN out;
END
$f$;
CREATE OR REPLACE FUNCTION s_strftime(fmt text, val double precision, VARIADIC mods text[] DEFAULT '{}') RETURNS text
LANGUAGE sql STABLE AS $f$ SELECT s_strftime(fmt, val::text, VARIADIC mods) $f$;

-- ---- CAST(x AS INTEGER) / CAST(x AS REAL), SQLite rules ---------------------
-- Numbers truncate toward zero (PostgreSQL would round). Text uses its
-- leading number ('12abc' -> 12, 'abc' -> 0) instead of raising an error.
CREATE OR REPLACE FUNCTION s_int(x double precision) RETURNS bigint
LANGUAGE sql IMMUTABLE AS $f$ SELECT trunc(x)::bigint $f$;
CREATE OR REPLACE FUNCTION s_int(x numeric) RETURNS bigint
LANGUAGE sql IMMUTABLE AS $f$ SELECT trunc(x)::bigint $f$;
CREATE OR REPLACE FUNCTION s_int(x bigint) RETURNS bigint
LANGUAGE sql IMMUTABLE AS $f$ SELECT x $f$;
CREATE OR REPLACE FUNCTION s_int(x text) RETURNS bigint
LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE WHEN x IS NULL THEN NULL
    ELSE COALESCE(substring(btrim(x) from '^[+-]?\d{1,18}')::bigint, 0) END
$f$;
CREATE OR REPLACE FUNCTION s_real(x double precision) RETURNS double precision
LANGUAGE sql IMMUTABLE AS $f$ SELECT x $f$;
CREATE OR REPLACE FUNCTION s_real(x numeric) RETURNS double precision
LANGUAGE sql IMMUTABLE AS $f$ SELECT x::double precision $f$;
CREATE OR REPLACE FUNCTION s_real(x bigint) RETURNS double precision
LANGUAGE sql IMMUTABLE AS $f$ SELECT x::double precision $f$;
CREATE OR REPLACE FUNCTION s_real(x text) RETURNS double precision
LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE WHEN x IS NULL THEN NULL
    ELSE COALESCE(substring(btrim(x) from '^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?')::double precision, 0) END
$f$;

-- ---- ROUND(real, digits) ------------------------------------------------------
-- PostgreSQL only rounds NUMERIC to N digits; SQLite rounds REAL too.
-- Rounds the exact stored binary value half-up, as SQLite does, so
-- 2.355 (stored as 2.35499999...) becomes 2.35, identical to SQLite.
CREATE OR REPLACE FUNCTION s_exact(x double precision) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE AS $f$
DECLARE
  bits bigint; e int; m numeric; k int; digs text; neg boolean;
BEGIN
  IF x IS NULL THEN RETURN NULL; END IF;
  IF x = 0 THEN RETURN 0; END IF;
  IF x = 'Infinity'::float8 OR x = '-Infinity'::float8 OR x = 'NaN'::float8 THEN RETURN x::numeric; END IF;
  bits := ('x' || encode(float8send(x), 'hex'))::bit(64)::bigint;
  neg := bits < 0;
  e := ((bits >> 52) & 2047)::int;
  m := (bits & 4503599627370495)::numeric;          -- 52-bit fraction
  IF e = 0 THEN e := 1; ELSE m := m + 4503599627370496; END IF;
  k := 1075 - e;                                     -- value = m * 2^-k
  IF k <= 0 THEN
    m := m * power(2::numeric, -k);
  ELSE
    -- m / 2^k = m * 5^k / 10^k, built as text so it stays exact
    digs := trunc(m * power(5::numeric, k))::text;
    IF length(digs) <= k THEN digs := lpad(digs, k + 1, '0'); END IF;
    m := (left(digs, length(digs) - k) || '.' || right(digs, k))::numeric;
  END IF;
  RETURN CASE WHEN neg THEN -m ELSE m END;
END
$f$;
CREATE OR REPLACE FUNCTION round(x double precision, digits integer) RETURNS double precision
LANGUAGE sql IMMUTABLE AS $f$ SELECT round(s_exact(x), greatest(digits, 0))::double precision $f$;
CREATE OR REPLACE FUNCTION round(x double precision, digits bigint) RETURNS double precision
LANGUAGE sql IMMUTABLE AS $f$ SELECT round(x, digits::int) $f$;

-- ---- LIKE on number columns ------------------------------------------------
-- SQLite compares a number with LIKE as text (e.g. searching ids or phone
-- numbers stored as numbers); PostgreSQL has no such operator, so it is added.
CREATE OR REPLACE FUNCTION s_ilike(a bigint, b text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $f$ SELECT a::text ILIKE b $f$;
CREATE OR REPLACE FUNCTION s_not_ilike(a bigint, b text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $f$ SELECT a::text NOT ILIKE b $f$;
CREATE OR REPLACE FUNCTION s_ilike(a double precision, b text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $f$ SELECT a::text ILIKE b $f$;
CREATE OR REPLACE FUNCTION s_not_ilike(a double precision, b text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $f$ SELECT a::text NOT ILIKE b $f$;
DO $d$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_operator WHERE oprname = '~~*' AND oprleft = 'bigint'::regtype AND oprright = 'text'::regtype) THEN
    CREATE OPERATOR ~~* (LEFTARG = bigint, RIGHTARG = text, FUNCTION = s_ilike);
    CREATE OPERATOR !~~* (LEFTARG = bigint, RIGHTARG = text, FUNCTION = s_not_ilike);
    CREATE OPERATOR ~~* (LEFTARG = double precision, RIGHTARG = text, FUNCTION = s_ilike);
    CREATE OPERATOR !~~* (LEFTARG = double precision, RIGHTARG = text, FUNCTION = s_not_ilike);
  END IF;
END
$d$;

-- ---- instr(text, search) -----------------------------------------------------
-- Position of the first match, 0 when absent (SQLite's instr). Returns an
-- integer so it can be used directly as a SUBSTR length.
CREATE OR REPLACE FUNCTION instr(a text, b text) RETURNS integer
LANGUAGE sql IMMUTABLE AS $f$ SELECT strpos(a, b) $f$;

