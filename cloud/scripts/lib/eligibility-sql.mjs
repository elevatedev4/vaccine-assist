// Pure SQL-building for eligibility_rule seed rows. Kept separate from
// eligibility-rules-data.mjs (the decoded content) and from
// build-eligibility-seed.mjs (the file-writing CLI) so it's unit
// testable with synthetic rule objects — see tests/eligibility-seed.test.ts.

function sqlString(value) {
  if (value === null || value === undefined) return "null";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlIntOrNull(value) {
  return value === null || value === undefined ? "null" : String(value);
}

function sqlBool(value) {
  return value ? "true" : "false";
}

/**
 * @param {Array<{shortCode:string,minAge:number|null,maxAge:number|null,conditionNote:string|null,pregnancyWarning:boolean,priority:number}>} rules
 * @returns {string} one `delete ... where vaccine_id in (...)` statement
 *   scoped to exactly the short_codes being (re-)seeded, so re-running
 *   the seed is idempotent without needing a unique constraint on
 *   eligibility_rule (its id is a random uuid, so plain `on conflict` has
 *   nothing to key off of).
 */
export function buildEligibilityDeleteStatement(rules) {
  const shortCodes = [...new Set(rules.map((r) => r.shortCode))];
  const list = shortCodes.map(sqlString).join(", ");
  return (
    `delete from eligibility_rule\n` +
    `where vaccine_id in (select id from vaccine where short_code in (${list}));`
  );
}

/**
 * @param {Array<{shortCode:string,minAge:number|null,maxAge:number|null,conditionNote:string|null,pregnancyWarning:boolean,priority:number}>} rules
 * @returns {string[]} one `insert into eligibility_rule ... select ...` statement per rule,
 *   joined on vaccine.short_code so a rule referencing a short_code that
 *   doesn't exist in the vaccine table simply inserts zero rows instead
 *   of erroring.
 */
export function buildEligibilitySqlStatements(rules) {
  return rules.map((rule) => {
    return (
      `insert into eligibility_rule (vaccine_id, min_age, max_age, condition_note, pregnancy_warning, priority)\n` +
      `select id, ${sqlIntOrNull(rule.minAge)}, ${sqlIntOrNull(rule.maxAge)}, ${sqlString(
        rule.conditionNote
      )}, ${sqlBool(rule.pregnancyWarning)}, ${sqlIntOrNull(rule.priority ?? 0)}\n` +
      `from vaccine where short_code = ${sqlString(rule.shortCode)};`
    );
  });
}
