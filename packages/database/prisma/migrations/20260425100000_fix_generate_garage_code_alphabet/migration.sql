-- BR-020 fixes for generate_garage_code(): alphabet alignment + random index off-by-one.
--
-- Bug 1 (alphabet drift):
-- The previous migration (20260424100000_rls_triggers_checks) installed
-- generate_garage_code() with a 22-letter alphabet (`ABCDEFGHJKLMNPRSTVWXYZ`,
-- including 'S') while the matching CHECK constraint chk_garage_code_format
-- was already on the 21-letter regex `^GO-[2-9]{3}-[A-HJ-NPRTV-Z]{4}$`
-- (without 'S'). Roughly 1 in 6 generated codes contained an 'S' and
-- failed the constraint at INSERT time. APPENDICE_B v1.2 already declares
-- the alphabet as 21 letters (excluded I/O/Q/S/U) — the function body
-- simply was not updated alongside the doc.
--
-- Bug 2 (random index off-by-one):
-- Both index expressions used `(random() * length(s))::INT + 1`. The
-- double→INT cast in PostgreSQL rounds to the nearest integer rather
-- than truncating, so `random()` close to 1.0 produces an index of
-- length(s)+1 — substr() with that index returns an empty string and
-- the resulting code drops a character (e.g. `GO-53-LLLE` instead of
-- `GO-534-LLLE`). The shorter code then fails the same CHECK regex.
-- Fix is `floor(random() * length(s))::INT + 1`, which yields a
-- uniform integer in [1, length(s)].
--
-- This migration replaces the function with both fixes. Every other
-- site (TS validators, factories, integration helpers, BR test
-- helpers) is already on 21 letters; APPENDICE_F prose is updated in
-- the same PR for consistency.

-- BR-020 / BR-021 garage_code generation with reduced alphabets
-- (digits 2-9, letters minus I/O/Q/S/U). Called from the app during
-- vehicle certification.
CREATE OR REPLACE FUNCTION generate_garage_code()
RETURNS VARCHAR(12) AS $$
DECLARE
    digits TEXT := '23456789';
    letters TEXT := 'ABCDEFGHJKLMNPRTVWXYZ';
    code TEXT;
    i INT;
BEGIN
    code := 'GO-';
    FOR i IN 1..3 LOOP
        code := code || substr(digits, floor(random() * length(digits))::INT + 1, 1);
    END LOOP;
    code := code || '-';
    FOR i IN 1..4 LOOP
        code := code || substr(letters, floor(random() * length(letters))::INT + 1, 1);
    END LOOP;
    RETURN code;
END;
$$ LANGUAGE plpgsql;
