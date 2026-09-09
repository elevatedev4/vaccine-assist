import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { requireAuthenticatedUser } from "@/lib/auth";
import { getAcuityCredentials } from "@/lib/acuity-credentials";
import {
  AcuityApiError,
  aggregateAppointmentCounts,
  fetchAppointmentsForRange,
  fetchAppointmentTypes,
} from "@/lib/acuity-client";
import { getCachedCounts, setCachedCounts } from "@/lib/acuity-poll-cache";
import { addDaysToChicagoDate, todayInChicago } from "@/lib/chicago-date";
import { compositeNameToMatchableBase, parseFluCompositeAgeBucket } from "@/lib/appointment-table";
import { env } from "@/lib/env";
import { matchVaccineName, type CatalogVaccine } from "@/lib/vaccine-matching";
import { normalizeNdc } from "@/lib/ndc";
import { collapseVaccinesByNdc, type CollapsibleVaccine } from "@/lib/ordering-ndc-collapse";
import { getOrderingGroup } from "@/lib/ordering-group";
import { matchFluAgeBandToVaccine, type FluMappingCatalogVaccine } from "@/lib/ordering-flu-mapping";
import { computeEffectiveTargets, recommendedTarget, type TargetInput } from "@/lib/ordering-targets";
import { getOrCreateAddressForUser } from "@/lib/on-hand/address";
import { isMissingColumnError, isMissingTableError } from "@/lib/schema-degradation";
import { getWalkInPct, walkInPctToRate } from "@/lib/ordering-settings";

/**
 * Ordering tab recommendation endpoint (V-ordering, 2026-08-19/20;
 * NDC-collapse + targets + inactive section, V-ordering-targets
 * 2026-09-08; walk-up % setting + COVID/Flu/Other regrouping + Pfizer
 * child-row exclusion, V-T26 2026-09-09).
 * GET, authed exactly like every other desktop-facing route
 * (requireAuthenticatedUser — see cloud/app/api/vaccines/route.ts).
 *
 * For each collapsed product/NDC group (cloud/lib/ordering-ndc-collapse.ts
 * — one row per NDC, or per vaccine id when a vaccine has no NDC; Will
 * msg 908: a 3-dose series like Gardasil is "still just one vaccine"),
 * combines:
 *   - upcoming7d: SUM of scheduled Acuity appointment counts over
 *     [today, today+6] (7 days inclusive), Chicago time, across every
 *     catalog vaccine collapsed into this row — reuses the SAME
 *     fetchAppointmentTypes/fetchAppointmentsForRange/aggregateAppointmentCounts
 *     path and acuity_poll_cache cache as app/api/acuity/poll/route.ts.
 *   - onHand / onHandAsOf: the latest `on_hand_count` row matching this
 *     group's NDC (falling back to any of its collapsed vaccine_ids —
 *     Will's brief), or null/null if none exists yet.
 *   - recommendedTarget / targetOnHand / effectiveTarget / order: see
 *     lib/ordering-targets.ts, computed with the EFFECTIVE walk-up rate
 *     (walkInPct/100 — see lib/ordering-settings.ts) rather than the
 *     hard-coded 25% default. targetOnHand is this row's OWN NDC-scoped
 *     override (null if none set). Group-scoped overrides (scope='group'
 *     rows in `ordering_target`, if any still exist from before V-T26)
 *     are deliberately IGNORED here (Will 2026-09-09: "Remove group
 *     target for now") — computeEffectiveTargets is called with an
 *     empty group-overrides map, so a stale group row never apportions
 *     across a group's rows; `groupTargets` stays in the response purely
 *     because GET/PUT /api/ordering/targets' own scope='group' support
 *     is left intact (Will's brief), not because the UI still uses it.
 *   - PFIZER CHILD-ROW EXCLUSION (V-T26 item 8): any vaccine whose name
 *     starts with "Pfizer 3-4" or "Pfizer 5-11" is dropped from the
 *     catalog before anything else runs, so neither section (active or
 *     inactive) can ever show them — Will is separately deactivating
 *     these in the DB, but this filter makes them disappear regardless
 *     of that column's state.
 *   - group: COVID/Flu/Other only (lib/ordering-group.ts's
 *     getOrderingGroup) — an Ordering-tab-only coarsening of
 *     lib/vaccine-group-catalog.ts's fine-grained groups, which the
 *     /data-entry guided flow and /physicians tab keep using unchanged.
 *
 * NO administered-doses field: there is no administration-tracking
 * table/endpoint anywhere in this schema — see lib/ordering-recommendation.ts.
 *
 * RESPONSE CONTRACT (V-ordering-targets, updated V-T26 — supersedes the
 * prior flat per-vaccine shape; the desktop app is not part of this
 * change, only cloud/app/ordering/page.tsx consumes this):
 *   {
 *     "onHandLastReceivedAt": "2026-08-19T13:00:00.000Z" | null,
 *     "targetsPending": false,   // true before 0011 has been applied
 *     "walkInPct": 25,           // the effective walk-up % this response was computed with
 *     "walkInPctPending": false, // true before 0012 has been applied (walkInPct is the default, 25)
 *     "groupTargets": { "Flu": 200 },  // group-scoped overrides still on file, by group display name — NOT applied to any row below, see doc comment above
 *     "rows": [
 *       {
 *         "key": "00006412102",           // digits-only NDC, or "vaccine:<id>"
 *         "vaccineName": "Gardasil",
 *         "ndc": "00006412102" | null,
 *         "group": "Other",               // "COVID" | "Flu" | "Other"
 *         "active": true,
 *         "upcoming7d": 12,
 *         "onHand": 8,
 *         "onHandAsOf": "2026-08-19T13:00:00.000Z" | null,
 *         "recommendedTarget": 20,
 *         "targetOnHand": null,           // this row's own NDC override, or null
 *         "effectiveTarget": 20,
 *         "targetSource": "recommended",  // "ndc" | "group" | "recommended" ("group" can no longer actually occur — group overrides are ignored — but the type is kept for API stability)
 *         "order": 12
 *       }
 *     ]
 *   }
 */

/**
 * Composite-base -> catalog-name resolution for COVID appointment counts,
 * scoped to THIS route only (review fix, 2026-09-05 — see
 * lib/vaccine-matching.ts's NAME_ALIASES comment for the full story). It
 * must NOT live in the shared NAME_ALIASES table: lib/on-hand-parser.ts
 * also calls matchVaccineName, for real free-text on-hand-count emails —
 * a manually-typed "COVID: 40" line has no age/brand composite to strip,
 * it's just ambiguous, and Will needs that line to keep surfacing
 * matched:false for his manual review rather than silently landing on
 * whichever product this table happens to point at.
 *
 * Keys are the exact (lowercased) strings compositeNameToMatchableBase
 * (lib/appointment-table.ts) produces. "covid moderna" is a documented
 * judgment call: Moderna currently has TWO catalog products by age
 * (Spikevax for 3-11, mNEXSPIKE for 12+ — see 0005_seed_lots.sql's step 2
 * comment), and the age-stripped composite can't tell them apart —
 * pointed at mNEXSPIKE (Moderna's 12+ product) as the more common case; a
 * real Moderna 3-11 appointment's order count lands on the wrong SKU
 * until this is split by age again. "covid" (brandless — the patient
 * expressed no brand preference) has the same kind of ambiguity and is
 * pointed at Comirnaty (Pfizer) as a single, deterministic default rather
 * than splitting the count across products.
 */
const COMPOSITE_BASE_TO_CATALOG_NAME: Record<string, string> = {
  "covid pfizer": "comirnaty 2025-26 12+",
  "covid moderna": "mnexspike",
  covid: "comirnaty 2025-26 12+",
};

/**
 * Resolves an already-composite-stripped vaccineName (see
 * compositeNameToMatchableBase) against the catalog: a COVID brand/
 * brandless base first checks COMPOSITE_BASE_TO_CATALOG_NAME above by
 * exact catalog name, then falls back to the normal shared
 * matchVaccineName (which is all a non-composite name — Flu, or any other
 * canonical vaccine — ever needs).
 */
function matchOrderingVaccineName(base: string, catalog: CatalogVaccine[]): CatalogVaccine | null {
  const targetName = COMPOSITE_BASE_TO_CATALOG_NAME[base.trim().toLowerCase()];
  if (targetName) {
    const direct = catalog.find((vaccine) => vaccine.name.trim().toLowerCase() === targetName);
    if (direct) return direct;
  }
  return matchVaccineName(base, catalog);
}

// V-T26 item 8 (Will 2026-09-09, verbatim): "any vaccine whose name
// starts with 'Pfizer 3-4' or 'Pfizer 5-11' must not appear in Ordering
// at all (neither active list nor Inactive section)." These are the two
// pediatric COVID catalog rows seeded by
// supabase/migrations/0005_seed_lots.sql — see that file's step 1 (both
// have ndc: null, so they were never collapsed with the adult Comirnaty
// row; each shows up as its own uncategorized "Other"-group row today).
// Case-insensitive prefix match, same posture as
// lib/ordering-ndc-collapse.ts's other name-based checks.
const EXCLUDED_PFIZER_CHILD_NAME_PREFIXES = ["Pfizer 3-4", "Pfizer 5-11"];

function isExcludedPfizerChildRow(name: string): boolean {
  const lower = name.trim().toLowerCase();
  return EXCLUDED_PFIZER_CHILD_NAME_PREFIXES.some((prefix) => lower.startsWith(prefix.toLowerCase()));
}

type OnHandEntry = { quantity: number | null; receivedAt: string };

/**
 * Fetches the latest matched on_hand_count rows, scoped to this
 * account's inbound address (plus legacy unattributed rows) when
 * `addressId` is given. Cascades through up to three query shapes so it
 * keeps working regardless of which of 0010 (inbound_email_address_id,
 * source) and 0011 (ndc) have been applied to this environment yet:
 *   1. select ..., ndc, source + scoped by address
 *   2. select ... (no ndc, no source) + scoped by address  [0010 and/or 0011 missing]
 *   3. select ... (no ndc, no source), unscoped            [0010 missing]
 * `source` (added by 0010, same table/migration as
 * inbound_email_address_id) is needed by the batch-sum logic below
 * (V-onhand-batch-sum) to tell an email batch from an upload batch — a
 * row with no `source` column available defaults to "email" downstream,
 * matching that column's own DB default.
 */
async function fetchOnHandRows(
  supabase: ReturnType<typeof getSupabaseServerClient>,
  addressId: string | null
): Promise<{ data: Array<Record<string, unknown>> | null; error: unknown }> {
  const baseColumns = "vaccine_id, quantity, received_at";
  const columnsWithNdcAndSource = `${baseColumns}, ndc, source`;

  async function runQuery(columns: string, scoped: boolean) {
    let query = supabase.from("on_hand_count").select(columns).eq("matched", true);
    if (scoped && addressId) {
      query = query.or(`inbound_email_address_id.eq.${addressId},inbound_email_address_id.is.null`);
    }
    return query.order("received_at", { ascending: false });
  }

  let { data, error } = await runQuery(columnsWithNdcAndSource, true);
  if (error && isMissingColumnError(error)) {
    ({ data, error } = await runQuery(baseColumns, true));
  }
  if (error && isMissingColumnError(error)) {
    ({ data, error } = await runQuery(baseColumns, false));
  }
  return { data: (data as Array<Record<string, unknown>> | null) ?? null, error };
}

export async function GET(request: Request) {
  const auth = await requireAuthenticatedUser(request);
  if ("error" in auth) return auth.error;

  try {
    const supabase = getSupabaseServerClient();

    // No `.eq("active", true)` filter — V-ordering-targets returns
    // inactive vaccines too (flagged `active: false`, still collapsed by
    // NDC) so the Ordering page can render its "Inactive vaccines"
    // section (Will msg 909).
    const { data: vaccinesData, error: vaccinesError } = await supabase
      .from("vaccine")
      .select("id, name, short_code, ndc, active")
      .order("name", { ascending: true });

    if (vaccinesError) {
      console.error("GET /api/ordering/recommendation: failed to load vaccine catalog", vaccinesError);
      return NextResponse.json({ error: "Failed to load vaccine catalog." }, { status: 500 });
    }

    // V-T26 item 8 (Will 2026-09-09): drop the Pfizer pediatric "child"
    // catalog rows entirely, active or inactive — Will is separately
    // deactivating these in the DB, but filtering by name HERE too means
    // they vanish from the Ordering tab regardless of that column's
    // state (and regardless of any future re-seed that recreates them).
    const catalog: CatalogVaccine[] = (vaccinesData ?? []).filter((vaccine) => !isExcludedPfizerChildRow(vaccine.name));

    // upcoming7d range: today through today+6 inclusive = 7 calendar days.
    const start = todayInChicago();
    const end = addDaysToChicagoDate(start, 6);

    const upcomingByVaccineId = new Map<string, number>();

    const credentials = await getAcuityCredentials();
    if (credentials) {
      try {
        const cacheSeconds = env.acuityPollCacheSeconds();
        const cached = await getCachedCounts(start, end, cacheSeconds);

        const counts =
          cached?.counts ??
          (await (async () => {
            const [appointmentTypes, { appointments, possiblyTruncated }] = await Promise.all([
              fetchAppointmentTypes(credentials.userId, credentials.apiKey),
              fetchAppointmentsForRange(credentials.userId, credentials.apiKey, start, end),
            ]);
            const nameById = new Map(appointmentTypes.map((type) => [type.id, type.name]));
            const freshCounts = aggregateAppointmentCounts(appointments, nameById);
            await setCachedCounts(start, end, freshCounts, possiblyTruncated);
            return freshCounts;
          })());

        // Flu-group catalog view for matchFluAgeBandToVaccine below —
        // same {id, name, active} shape collapsibleCatalog (further
        // down) builds, but computed here since it's needed inside this
        // loop, before collapsibleCatalog exists yet.
        const fluMappingCatalog: FluMappingCatalogVaccine[] = catalog.map((vaccine) => ({
          id: vaccine.id,
          name: vaccine.name,
          active: (vaccine as { active?: boolean }).active ?? true,
        }));

        for (const { vaccineName, count } of counts) {
          // V-T-flu-map (Will 2026-09-09): a Flu appointment's KNOWN age
          // band ("3-64" vs "65+" — the SAME data the /appointments
          // table's "Flu 3-64"/"Flu 65+" columns already split on)
          // determines which flu PRODUCT the count should land on —
          // Flucelvax for <65, Fluad for 65+ — so a Flu composite with a
          // known band is routed through matchFluAgeBandToVaccine BEFORE
          // falling through to the generic brand/name matcher below.
          // "unknown"-band Flu composites (no age question answered)
          // deliberately fall through to that same generic matcher
          // UNCHANGED — Will's brief only specifies a product mapping
          // for the two known bands, and the generic matcher's existing
          // "Flu · Unknown" -> "Flu" -> substring-match behavior (see
          // compositeNameToMatchableBase) already covers that case.
          const fluAgeBand = parseFluCompositeAgeBucket(vaccineName);
          if (fluAgeBand === "3-64" || fluAgeBand === "65+") {
            const fluMatch = matchFluAgeBandToVaccine(fluAgeBand, fluMappingCatalog);
            if (fluMatch) {
              upcomingByVaccineId.set(fluMatch.id, (upcomingByVaccineId.get(fluMatch.id) ?? 0) + count);
            }
            continue;
          }

          // COVID counts arrive as an aggregation composite ("COVID ·
          // Pfizer · 65+" — see covidCompositeName in
          // lib/acuity-client.ts) that doesn't resemble any catalog name
          // on its own. Strip it down to a matchable brand/product
          // string (age is never relevant to an order quantity) — see
          // compositeNameToMatchableBase's doc comment — then resolve it
          // against the catalog via THIS route's own
          // matchOrderingVaccineName, not the shared matchVaccineName
          // directly (see COMPOSITE_BASE_TO_CATALOG_NAME above for why
          // that resolution must stay out of lib/vaccine-matching.ts's
          // NAME_ALIASES). A non-composite name passes through
          // compositeNameToMatchableBase unchanged and matches exactly
          // as it always has.
          const match = matchOrderingVaccineName(compositeNameToMatchableBase(vaccineName), catalog);
          // An appointment vaccine name with no catalog match simply
          // doesn't contribute to any row's upcoming7d — there's no
          // catalog vaccine to attach the count to. Same tolerant,
          // never-throw posture as lib/on-hand-parser.ts's unmatched
          // lines.
          if (!match) continue;
          upcomingByVaccineId.set(match.id, (upcomingByVaccineId.get(match.id) ?? 0) + count);
        }
      } catch (err) {
        const message = err instanceof AcuityApiError ? err.message : "Failed to poll Acuity for appointments.";
        console.error("GET /api/ordering/recommendation: Acuity fetch failed", message);
        return NextResponse.json({ error: message }, { status: 502 });
      }
    }
    // credentials === null: Acuity isn't configured yet — every row's
    // upcoming7d simply stays 0, same "not configured yet" tolerance as
    // the rest of this app (see app/api/acuity/poll/route.ts).

    // V-onhand-account-address (Will 2026-09-08): scope on-hand rows to
    // THIS account's inbound address, OR (transitionally) a legacy row
    // with no address at all. addressId stays null (falling back to the
    // pre-feature, unscoped query below) ONLY when
    // inbound_email_address doesn't exist yet in this environment
    // (0010 pending) — review fix, V-ordering-targets item 7: any OTHER
    // failure (a real Supabase error) must not be silently swallowed.
    let addressId: string | null = null;
    try {
      addressId = (await getOrCreateAddressForUser(auth.user.id)).id;
    } catch (err) {
      if (!isMissingTableError(err)) {
        console.error("GET /api/ordering/recommendation: on-hand address lookup failed", err);
        return NextResponse.json({ error: "on-hand lookup failed" }, { status: 503 });
      }
      addressId = null;
    }

    const { data: onHandRows, error: onHandError } = await fetchOnHandRows(supabase, addressId);

    if (onHandError) {
      console.error("GET /api/ordering/recommendation: failed to load on-hand counts", onHandError);
      return NextResponse.json({ error: "Failed to load on-hand counts." }, { status: 500 });
    }

    // Rows are ordered received_at DESC across every vaccine — used only
    // for onHandLastReceivedAt (the page-level "last received" message)
    // below; the per-product batching itself (computeLatestBatchOnHand)
    // groups ALL of a key's rows itself rather than relying on that
    // order, since a batch is now a TIME WINDOW, not "the first row
    // seen."
    //
    // V-onhand-batch-sum (Will, 2026-09-09 4:31pm, from a real 47-line
    // Pioneer BOH PDF, review follow-up 2026-09-09 evening): several
    // products arrive as MULTIPLE Pioneer lines in ONE report (Abrysvo
    // 0/0/9, Fluad 0/189/0, mNEXSPIKE 0/1114, Spikevax 11/0/0/0, Prevnar
    // 0/8, Shingrix 0/11) — on-hand for a product is the SUM of every row
    // in that report, not one arbitrary row. The FIRST version of this
    // fix batched rows by byte-identical `received_at`, which turned out
    // to be wrong: real Pioneer-triggered inserts land at slightly
    // different millisecond timestamps within the same send (observed
    // 21:31:05.413 vs 21:31:05.457), not one shared `now()` value, so
    // that version silently kept only the single latest-ms row again.
    //
    // A "batch" is now a TIME WINDOW, computed independently per product
    // key (vaccine_id or ndc): among that key's own rows, take the
    // newest `received_at`, then sum every row for that key within
    // BATCH_WINDOW_MS of it AND sharing that newest row's `source`
    // (email vs upload — see fetchOnHandRows) — a row older than the
    // window, or from a different source, is excluded entirely (an older
    // batch, or a same-day batch from the other ingestion path, never
    // adds to the latest one). A product with no rows in whatever the
    // GLOBAL latest batch happens to be still gets its own latest-batch
    // total, computed the same way, independently.
    const BATCH_WINDOW_MS = 120_000; // 120 seconds

    type RawOnHandRow = { key: string; quantity: number | null; receivedAt: string; source: string };

    function computeLatestBatchOnHand(rows: RawOnHandRow[]): Map<string, OnHandEntry> {
      const byKey = new Map<string, RawOnHandRow[]>();
      for (const row of rows) {
        const list = byKey.get(row.key);
        if (list) list.push(row);
        else byKey.set(row.key, [row]);
      }

      const result = new Map<string, OnHandEntry>();
      for (const [key, keyRows] of byKey) {
        let newest = keyRows[0];
        for (const row of keyRows) {
          if (row.receivedAt > newest.receivedAt) newest = row;
        }
        const windowStartMs = new Date(newest.receivedAt).getTime() - BATCH_WINDOW_MS;

        let quantity: number | null = null;
        for (const row of keyRows) {
          if (row.source !== newest.source) continue;
          if (new Date(row.receivedAt).getTime() < windowStartMs) continue;
          if (row.quantity === null) continue;
          quantity = (quantity ?? 0) + row.quantity;
        }
        result.set(key, { quantity, receivedAt: newest.receivedAt });
      }
      return result;
    }

    let onHandLastReceivedAt: string | null = null;
    const byVaccineIdRows: RawOnHandRow[] = [];
    const byNdcRows: RawOnHandRow[] = [];
    for (const row of onHandRows ?? []) {
      const receivedAt = row.received_at as string;
      const quantity = (row.quantity as number | null) ?? null;
      // A pre-0010 row (or a fetchOnHandRows fallback tier that couldn't
      // select `source` at all) has no way to know its ingestion path —
      // default to "email", the same default on_hand_count.source itself
      // carries (0010_inbound_email_address.sql).
      const source = (row.source as string | undefined) ?? "email";
      if (onHandLastReceivedAt === null) onHandLastReceivedAt = receivedAt;

      const vaccineId = row.vaccine_id as string | null;
      if (vaccineId) byVaccineIdRows.push({ key: vaccineId, quantity, receivedAt, source });

      const rowNdc = normalizeNdc((row.ndc as string | null | undefined) ?? null);
      if (rowNdc) byNdcRows.push({ key: rowNdc, quantity, receivedAt, source });
    }

    const latestOnHandByVaccineId = computeLatestBatchOnHand(byVaccineIdRows);
    const latestOnHandByNdc = computeLatestBatchOnHand(byNdcRows);

    // NDC collapse (Will msg 908): one row per product/NDC rather than
    // one per catalog vaccine — a 3-dose series like Gardasil (3 catalog
    // rows sharing one NDC) becomes ONE recommendation row.
    const collapsibleCatalog: CollapsibleVaccine[] = catalog.map((vaccine) => ({
      id: vaccine.id,
      name: vaccine.name,
      ndc: vaccine.ndc ?? null,
      active: (vaccine as { active?: boolean }).active ?? true,
    }));
    const collapsedGroups = collapseVaccinesByNdc(collapsibleCatalog);

    for (const group of collapsedGroups) {
      if (group.vaccineIds.length > 1) {
        console.log(
          `GET /api/ordering/recommendation: collapsed ${group.vaccineIds.length} vaccine rows into 1 row — ` +
            `ndc=${group.ndc ?? "(none)"} name="${group.vaccineName}" ids=[${group.vaccineIds.join(", ")}]`
        );
      }
    }

    function onHandFor(group: (typeof collapsedGroups)[number]): OnHandEntry | null {
      if (group.ndc) {
        const byNdc = latestOnHandByNdc.get(group.ndc);
        if (byNdc) return byNdc;
      }
      let best: OnHandEntry | null = null;
      for (const id of group.vaccineIds) {
        const entry = latestOnHandByVaccineId.get(id);
        if (entry && (!best || entry.receivedAt > best.receivedAt)) best = entry;
      }
      return best;
    }

    // Targets (Will msg 904): load overrides — degrades to
    // targetsPending:true (never an error) before 0011 has been applied.
    const ndcOverrides: Record<string, number> = {};
    const groupOverrides: Record<string, number> = {};
    let targetsPending = false;
    const { data: targetRows, error: targetError } = await supabase
      .from("ordering_target")
      .select("scope, key, target_on_hand");
    if (targetError) {
      if (isMissingTableError(targetError)) {
        targetsPending = true;
      } else {
        console.error("GET /api/ordering/recommendation: failed to load ordering targets", targetError);
        return NextResponse.json({ error: "Failed to load ordering targets." }, { status: 500 });
      }
    } else {
      for (const row of (targetRows as Array<{ scope: string; key: string; target_on_hand: number }>) ?? []) {
        if (row.scope === "ndc") ndcOverrides[row.key] = row.target_on_hand;
        else if (row.scope === "group") groupOverrides[row.key] = row.target_on_hand;
      }
    }

    // Walk-up % (V-T26 item 1, Will 2026-09-09): the effective rate
    // every recommendedTarget/computeEffectiveTargets call below uses,
    // replacing the previously hard-coded 25% — degrades to
    // DEFAULT_WALK_IN_PCT (25) with walkInPctPending:true before 0012
    // has been applied, never an error (same posture as targetsPending
    // above).
    let walkInPct: number;
    let walkInPctPending: boolean;
    try {
      const result = await getWalkInPct(supabase);
      walkInPct = result.pct;
      walkInPctPending = result.pending;
    } catch (err) {
      console.error("GET /api/ordering/recommendation: failed to load ordering.walk_in_pct", err);
      return NextResponse.json({ error: "Failed to load ordering settings." }, { status: 500 });
    }
    const walkInRate = walkInPctToRate(walkInPct);

    type BuiltRow = {
      key: string;
      vaccineName: string;
      ndc: string | null;
      group: string;
      active: boolean;
      upcoming7d: number;
      onHand: number | null;
      onHandAsOf: string | null;
    };

    const builtRows: BuiltRow[] = collapsedGroups.map((group) => {
      const upcoming7d = group.vaccineIds.reduce((sum, id) => sum + (upcomingByVaccineId.get(id) ?? 0), 0);
      const onHandEntry = onHandFor(group);
      return {
        key: group.key,
        vaccineName: group.vaccineName,
        ndc: group.ndc,
        // V-T26 item 5: COVID/Flu/Other only on the Ordering tab — see
        // lib/ordering-group.ts's doc comment (this is also what fixes
        // item 8's "Other renders twice" bug; see that file).
        group: getOrderingGroup(group.vaccineName),
        active: group.active,
        upcoming7d,
        onHand: onHandEntry?.quantity ?? null,
        onHandAsOf: onHandEntry?.receivedAt ?? null,
      };
    });

    // Group apportionment (lib/ordering-targets.ts) considers ONLY
    // active rows (Will's brief) — inactive rows still get a
    // recommended/order figure, just never participate in (or benefit
    // from) a group-level split. V-T26 item 6 (Will 2026-09-09: "Remove
    // group target for now"): group overrides are passed as an EMPTY
    // map here, not `groupOverrides` — any scope='group' row still on
    // file (see the targets fetch above) is loaded but deliberately
    // never applied, so it can no longer affect any row's effective
    // target/order (Will's brief: "ignore scope='group' rows in the
    // effective-target computation; don't delete them").
    const activeTargetInputs: TargetInput[] = builtRows
      .filter((row) => row.active)
      .map((row) => ({ key: row.key, ndc: row.ndc, group: row.group, upcoming7d: row.upcoming7d, onHand: row.onHand }));
    const activeResults = computeEffectiveTargets(activeTargetInputs, { ndc: ndcOverrides, group: {} }, walkInRate);
    const activeResultByKey = new Map(activeResults.map((result) => [result.key, result]));

    const rows = builtRows.map((row) => {
      if (row.active) {
        const result = activeResultByKey.get(row.key);
        if (result) {
          return {
            key: row.key,
            vaccineName: row.vaccineName,
            ndc: row.ndc,
            group: row.group,
            active: row.active,
            upcoming7d: row.upcoming7d,
            onHand: row.onHand,
            onHandAsOf: row.onHandAsOf,
            recommendedTarget: result.recommendedTarget,
            targetOnHand: row.ndc ? ndcOverrides[row.ndc] ?? null : null,
            effectiveTarget: result.effectiveTarget,
            targetSource: result.targetSource,
            order: result.order,
          };
        }
      }

      // Inactive row (or, defensively, a missing active-result lookup):
      // NDC override only, no group apportionment.
      const recommended = recommendedTarget(row.upcoming7d, walkInRate);
      const ndcOverride = row.ndc ? ndcOverrides[row.ndc] : undefined;
      const effective = ndcOverride ?? recommended;
      return {
        key: row.key,
        vaccineName: row.vaccineName,
        ndc: row.ndc,
        group: row.group,
        active: row.active,
        upcoming7d: row.upcoming7d,
        onHand: row.onHand,
        onHandAsOf: row.onHandAsOf,
        recommendedTarget: recommended,
        targetOnHand: ndcOverride ?? null,
        effectiveTarget: effective,
        targetSource: (ndcOverride !== undefined ? "ndc" : "recommended") as "ndc" | "recommended",
        order: Math.max(0, effective - (row.onHand ?? 0)),
      };
    });

    return NextResponse.json({
      onHandLastReceivedAt,
      targetsPending,
      walkInPct,
      walkInPctPending,
      groupTargets: groupOverrides,
      rows,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Supabase is not configured." },
      { status: 503 }
    );
  }
}
