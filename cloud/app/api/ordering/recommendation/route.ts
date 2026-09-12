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
import { getOrCreateAddressForUser } from "@/lib/on-hand/address";
import { isMissingColumnError, isMissingTableError } from "@/lib/schema-degradation";
import { getWalkInPct, walkInPctToRate } from "@/lib/ordering-settings";
import { extractUnitFromRawLine } from "@/lib/on-hand/quantity-cell";
import { computeDemandTarget } from "@/lib/ordering-recommendation";
import { administeredSummary } from "@/lib/administered/store";

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
 * TREND-AWARE DEMAND (V-ordering-trend, Will 2026-09-12: "We need our
 * ordering algorithm to be cognizant of how many vaccines we've done in
 * the last week and recommend that we keep up with the trends, since we
 * take walk-ins and not just schedule."): each row's `recommendedTarget`
 * is now max(scheduledDemand, trendDemand) — see
 * lib/ordering-recommendation.ts's computeDemandTarget doc comment for
 * why trendDemand (given7d, walk-ins already baked in) gets no
 * additional walk-in buffer. `given7d` comes from ONE
 * administeredSummary(supabase, { days: 7, until: yesterday }) call
 * (lib/administered/store.ts, owned by feat/administered-ingest — this
 * route only reads it), mapped onto each collapsed product the same way
 * upcoming7d is (summed across the product's own vaccine ids). A failed
 * summary call (table not migrated yet, etc.) degrades every row's
 * given7d to 0 and sets the top-level `trendUnavailable: true` flag —
 * this route must never break the page over trend data being
 * unavailable.
 *
 * Since this replaced the previous computeEffectiveTargets call (whose
 * group-apportionment branch was already permanently dead here — V-T26
 * item 6 always passes an EMPTY group-overrides map, see the old comment
 * this replaced), an NDC-scoped "Your target" override still wins
 * outright over BOTH demand estimates for every row (active or
 * inactive) — same override precedence as before, just computed inline
 * below instead of via lib/ordering-targets.ts. That file/route (GET/PUT
 * /api/ordering/targets) is untouched and still the source of the NDC
 * overrides read here.
 *
 * RESPONSE CONTRACT (V-ordering-targets, updated V-T26, updated
 * V-ordering-trend — supersedes the prior flat per-vaccine shape; the
 * desktop app is not part of this change, only cloud/app/ordering/page.tsx
 * consumes this):
 *   {
 *     "onHandLastReceivedAt": "2026-08-19T13:00:00.000Z" | null,
 *     "targetsPending": false,   // true before 0011 has been applied
 *     "walkInPct": 25,           // the effective walk-up % this response was computed with
 *     "walkInPctPending": false, // true before 0012 has been applied (walkInPct is the default, 25)
 *     "trendUnavailable": false, // true when administeredSummary threw — every row's given7d is 0 for this response
 *     "groupTargets": { "Flu": 200 },  // group-scoped overrides still on file, by group display name — NOT applied to any row below, see doc comment above
 *     "rows": [
 *       {
 *         "key": "00006412102",           // digits-only NDC, or "vaccine:<id>"
 *         "vaccineName": "Gardasil",
 *         "ndc": "00006412102" | null,
 *         "group": "Other",               // "COVID" | "Flu" | "Other"
 *         "active": true,
 *         "upcoming7d": 12,
 *         "given7d": 9,                   // doses administered over the last 7 COMPLETE days (0 when trendUnavailable, or none ingested yet)
 *         "onHand": 8,
 *         "onHandAsOf": "2026-08-19T13:00:00.000Z" | null,
 *         "unitSize": "1 EA" | "0.5 ML" | "1" | null,  // stock_size (+ unit recovered from raw_line, when present) of the latest matched batch line — V-onhand-ndc-units
 *         "scheduledDemand": 15,          // upcoming7d + its walk-in buffer (the old "recommendedTarget" formula)
 *         "trendDemand": 9,               // given7d, unbuffered
 *         "recommendedTarget": 15,        // max(scheduledDemand, trendDemand), BEFORE any override
 *         "targetOnHand": null,           // this row's own NDC override, or null
 *         "effectiveTarget": 15,
 *         "targetSource": "scheduled",    // "override" | "scheduled" | "trend"
 *         "order": 7
 *       }
 *     ]
 *   }
 */

/**
 * Composite-base -> catalog-name-PREFIX resolution for COVID appointment
 * counts, scoped to THIS route only (review fix, 2026-09-05 — see
 * lib/vaccine-matching.ts's NAME_ALIASES comment for the full story). It
 * must NOT live in the shared NAME_ALIASES table: lib/on-hand-parser.ts
 * also calls matchVaccineName, for real free-text on-hand-count emails —
 * a manually-typed "COVID: 40" line has no age/brand composite to strip,
 * it's just ambiguous, and Will needs that line to keep surfacing
 * matched:false for his manual review rather than silently landing on
 * whichever product this table happens to point at.
 *
 * Keys are the exact (lowercased) strings compositeNameToMatchableBase
 * (lib/appointment-table.ts) produces. Values are a case-insensitive
 * NAME PREFIX, not an exact name — SEASON-AGNOSTIC on purpose (review
 * follow-up, live bug: the lot-list apply renamed the on-file DB rows
 * "Comirnaty 2025-26 12+" -> "Comirnaty 2026-27 12+" and "mNEXSPIKE" ->
 * "mNEXSPIKE 2026-27" mid-season, which silently zeroed upcoming7d for
 * BOTH COVID products under the old exact-string match). Same
 * namePrefix tolerance lib/vaccine-product-catalog.ts's Comirnaty row
 * already uses, for the same reason.
 *
 * "covid moderna" is a documented judgment call: Moderna currently has
 * TWO catalog products by age (Spikevax for 3-11, mNEXSPIKE for 12+ —
 * see 0005_seed_lots.sql's step 2 comment), and the age-stripped
 * composite can't tell them apart — pointed at mNEXSPIKE (Moderna's
 * 12+ product) as the more common case; a real Moderna 3-11
 * appointment's order count lands on the wrong SKU until this is split
 * by age again. "covid" (brandless — the patient expressed no brand
 * preference) has the same kind of ambiguity and is pointed at
 * Comirnaty (Pfizer) as a single, deterministic default rather than
 * splitting the count across products. Neither of those RULES changed
 * in this fix — only the name match itself became prefix-based.
 */
const COMPOSITE_BASE_TO_CATALOG_NAME_PREFIX: Record<string, string> = {
  "covid pfizer": "comirnaty",
  "covid moderna": "mnexspike",
  covid: "comirnaty",
};

/**
 * Resolves an already-composite-stripped vaccineName (see
 * compositeNameToMatchableBase) against the catalog: a COVID brand/
 * brandless base first checks COMPOSITE_BASE_TO_CATALOG_NAME_PREFIX
 * above by case-insensitive name PREFIX (season-agnostic — see that
 * table's doc comment), then falls back to the normal shared
 * matchVaccineName (which is all a non-composite name — Flu, or any
 * other canonical vaccine — ever needs).
 */
function matchOrderingVaccineName(base: string, catalog: CatalogVaccine[]): CatalogVaccine | null {
  const targetPrefix = COMPOSITE_BASE_TO_CATALOG_NAME_PREFIX[base.trim().toLowerCase()];
  if (targetPrefix) {
    const direct = catalog.find((vaccine) => vaccine.name.trim().toLowerCase().startsWith(targetPrefix));
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

type OnHandEntry = { quantity: number | null; receivedAt: string; unitSize: string | null };

/**
 * Fetches the latest matched on_hand_count rows, scoped to this
 * account's inbound address (plus legacy unattributed rows) when
 * `addressId` is given. Cascades through up to three query shapes so it
 * keeps working regardless of which of 0010 (inbound_email_address_id,
 * source) and 0011 (ndc, stock_size) have been applied to this
 * environment yet:
 *   1. select ..., ndc, source, stock_size + scoped by address
 *   2. select ... (no ndc/source/stock_size) + scoped by address  [0010 and/or 0011 missing]
 *   3. select ... (no ndc/source/stock_size), unscoped            [0010 missing]
 * `source` (added by 0010, same table/migration as
 * inbound_email_address_id) is needed by the batch-sum logic below
 * (V-onhand-batch-sum) to tell an email batch from an upload batch — a
 * row with no `source` column available defaults to "email" downstream,
 * matching that column's own DB default. `raw_line` is always selected
 * (0006, never gated behind a migration tier) — V-onhand-ndc-units'
 * `unitSize` response field recovers a unit (EA/ML) from it (see
 * lib/on-hand/quantity-cell.ts's extractUnitFromRawLine); `stock_size`
 * is the other half of that field, gated behind 0011 same as `ndc`.
 */
async function fetchOnHandRows(
  supabase: ReturnType<typeof getSupabaseServerClient>,
  addressId: string | null
): Promise<{ data: Array<Record<string, unknown>> | null; error: unknown }> {
  const baseColumns = "vaccine_id, quantity, received_at, raw_line";
  const columnsWithNdcAndSource = `${baseColumns}, ndc, source, stock_size`;

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

    // NDC collapse (Will msg 908): one row per product/NDC rather than
    // one per catalog vaccine — a 3-dose series like Gardasil (3 catalog
    // rows sharing one NDC) becomes ONE recommendation row. Computed
    // HERE (before on-hand rows are processed below) because
    // V-onhand-attribution's per-row product attribution needs
    // vaccineIdToGroupKey/ndcToGroupKey, built from these groups, before
    // it can bucket a single on-hand row.
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

    // V-onhand-attribution (review follow-up, live bug after d7e123f):
    // vaccine_id -> the product group that OWNS it, and (DB) ndc -> group
    // key — used to attribute an on_hand_count row to the correct
    // product below. See the on-hand loop's own doc comment for why this
    // must be vaccine_id-first, not ndc-first.
    const vaccineIdToGroupKey = new Map<string, string>();
    const ndcToGroupKey = new Map<string, string>();
    for (const group of collapsedGroups) {
      for (const id of group.vaccineIds) vaccineIdToGroupKey.set(id, group.key);
      if (group.ndc) ndcToGroupKey.set(group.ndc, group.key);
    }

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

    // given7d (V-ordering-trend, Will 2026-09-12): last week's ACTUAL
    // administered pace, per catalog vaccine id — ONE
    // administeredSummary call over the last 7 COMPLETE Chicago days
    // (until = yesterday, so a partial "today" never makes the trend
    // look artificially low). This route only READS
    // lib/administered/store.ts (owned by feat/administered-ingest); it
    // never writes to it. Degrades to every row's given7d = 0 plus the
    // top-level `trendUnavailable: true` flag on ANY failure (missing
    // table before that branch is merged/migrated, a genuine Supabase
    // error, etc.) — trend data being unavailable must never break this
    // page, same posture as every other degrade in this route.
    const givenByVaccineId = new Map<string, number>();
    let trendUnavailable = false;
    try {
      const yesterday = addDaysToChicagoDate(todayInChicago(), -1);
      const summary = await administeredSummary(supabase, { days: 7, until: yesterday });
      for (const [vaccineId, count] of Object.entries(summary.byVaccineId)) {
        givenByVaccineId.set(vaccineId, count);
      }
    } catch (err) {
      console.error("GET /api/ordering/recommendation: administeredSummary failed", err);
      trendUnavailable = true;
    }

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
    // A "batch" is now a TIME WINDOW, computed independently per PRODUCT
    // (not per raw key — see V-onhand-attribution below): among a
    // product's own rows, take the newest `received_at`, then sum every
    // row for that product within BATCH_WINDOW_MS of it AND sharing that
    // newest row's `source` (email vs upload — see fetchOnHandRows) — a
    // row older than the window, or from a different source, is excluded
    // entirely (an older batch, or a same-day batch from the other
    // ingestion path, never adds to the latest one). A product with no
    // rows in whatever the GLOBAL latest batch happens to be still gets
    // its own latest-batch total, computed the same way, independently.
    const BATCH_WINDOW_MS = 120_000; // 120 seconds

    type RawOnHandRow = {
      key: string;
      quantity: number | null;
      receivedAt: string;
      source: string;
      stockSize: number | null;
      rawLine: string;
    };

    // unitSize (V-onhand-ndc-units, Will 2026-09-09/10: "display unit
    // size for each item... Pkg size is now Units/pkg"): stock_size from
    // whichever row this key's `newest` batch line is (same row
    // `receivedAt`/`quantity` already come from below) plus the unit
    // recovered from that SAME row's raw_line — not summed/averaged
    // across a multi-line batch, since a per-dose stock size isn't an
    // additive quantity the way BOH is; the newest line is the most
    // representative single value when a product has more than one line
    // in its latest batch.
    function unitSizeFor(stockSize: number | null, rawLine: string): string | null {
      if (stockSize === null) return null;
      const unit = extractUnitFromRawLine(rawLine);
      return unit ? `${stockSize} ${unit}` : `${stockSize}`;
    }

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
        result.set(key, {
          quantity,
          receivedAt: newest.receivedAt,
          unitSize: unitSizeFor(newest.stockSize, newest.rawLine),
        });
      }
      return result;
    }

    // V-onhand-attribution (review follow-up, live bug after d7e123f):
    // a MATCHED on-hand row's `vaccine_id` is authoritative — it's the
    // exact product lib/on-hand/pioneer-boh.ts's matcher already
    // resolved this row to — and must win over the row's own `ndc`
    // column, which can legitimately be Pioneer's PACKAGE NDC (e.g.
    // Fluad "70461-0026-03") rather than the product's DB ndc
    // ("70461-0123-03") — see lib/on-hand/pioneer-boh.ts's
    // catalogPackageNdcForVaccine fallback, which matches a Pioneer line
    // by EITHER value. Bucketing rows by their own raw ndc (the OLD
    // behavior here) could split one product's several same-report lines
    // across multiple unrelated ndc-keyed batches — or, worse, let a
    // STALE delivery whose ndc happened to equal the DB ndc win over a
    // FRESHER matched-by-vaccine_id delivery that used the package ndc
    // instead (the exact bug: an 04:52Z xlsx upload's on-file-ndc-shaped
    // row outranked a 4:31pm email's package-ndc-shaped row for Fluad).
    //
    // So attribution now happens per ROW, before batching: a row with
    // `vaccine_id` set resolves to whichever product group OWNS that
    // vaccine_id (vaccineIdToGroupKey, built above from collapsedGroups)
    // — its own `ndc` is never consulted. ONLY a row with NO vaccine_id
    // (unmatched) falls back to an ndc-based lookup (ndcToGroupKey, the
    // product's own DB ndc). A row that resolves to neither (an orphaned
    // vaccine_id, or an unmatched row whose ndc matches no product) isn't
    // attributed to any row's on-hand total — same as before.
    let onHandLastReceivedAt: string | null = null;
    const productOnHandRows: RawOnHandRow[] = [];
    for (const row of onHandRows ?? []) {
      const receivedAt = row.received_at as string;
      const quantity = (row.quantity as number | null) ?? null;
      // A pre-0010 row (or a fetchOnHandRows fallback tier that couldn't
      // select `source` at all) has no way to know its ingestion path —
      // default to "email", the same default on_hand_count.source itself
      // carries (0010_inbound_email_address.sql).
      const source = (row.source as string | undefined) ?? "email";
      const stockSize = (row.stock_size as number | null | undefined) ?? null;
      const rawLine = (row.raw_line as string | undefined) ?? "";
      if (onHandLastReceivedAt === null) onHandLastReceivedAt = receivedAt;

      const vaccineId = row.vaccine_id as string | null;
      const groupKey = vaccineId
        ? vaccineIdToGroupKey.get(vaccineId)
        : ndcToGroupKey.get(normalizeNdc((row.ndc as string | null | undefined) ?? null) ?? "");
      if (groupKey) productOnHandRows.push({ key: groupKey, quantity, receivedAt, source, stockSize, rawLine });
    }

    const latestOnHandByGroupKey = computeLatestBatchOnHand(productOnHandRows);

    function onHandFor(group: (typeof collapsedGroups)[number]): OnHandEntry | null {
      return latestOnHandByGroupKey.get(group.key) ?? null;
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
    // every scheduledDemand call below uses, replacing the previously
    // hard-coded 25% — degrades to DEFAULT_WALK_IN_PCT (25) with
    // walkInPctPending:true before 0012 has been applied, never an
    // error (same posture as targetsPending above).
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
      given7d: number;
      onHand: number | null;
      onHandAsOf: string | null;
      unitSize: string | null;
    };

    const builtRows: BuiltRow[] = collapsedGroups.map((group) => {
      const upcoming7d = group.vaccineIds.reduce((sum, id) => sum + (upcomingByVaccineId.get(id) ?? 0), 0);
      const given7d = group.vaccineIds.reduce((sum, id) => sum + (givenByVaccineId.get(id) ?? 0), 0);
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
        given7d,
        onHand: onHandEntry?.quantity ?? null,
        onHandAsOf: onHandEntry?.receivedAt ?? null,
        unitSize: onHandEntry?.unitSize ?? null,
      };
    });

    // Per-row target (V-ordering-trend): max(scheduledDemand, trendDemand)
    // — see lib/ordering-recommendation.ts's computeDemandTarget — with
    // an NDC-scoped "Your target" override still winning outright over
    // BOTH estimates, for active AND inactive rows alike. This replaces
    // the previous call into lib/ordering-targets.ts's
    // computeEffectiveTargets: that function's GROUP-apportionment
    // branch was already permanently dead here (V-T26 item 6 always
    // passed an EMPTY group-overrides map — "Remove group target for
    // now" — so no scope='group' row has ever actually apportioned
    // anything through this route), so folding its remaining
    // (NDC-override-wins, else-recommended) behavior in here directly
    // is behavior-preserving for everything except the new
    // trend-awareness itself. `ordering_target`'s scope='group' rows are
    // still read above (groupOverrides) and returned in `groupTargets`
    // for API stability (Will's brief: "don't delete them"), just never
    // applied to any row.
    const rows = builtRows.map((row) => {
      const demand = computeDemandTarget(row.upcoming7d, row.given7d, walkInRate);
      const ndcOverride = row.ndc ? ndcOverrides[row.ndc] : undefined;
      const effectiveTarget = ndcOverride ?? demand.demandTarget;
      const targetSource: "override" | "scheduled" | "trend" =
        ndcOverride !== undefined ? "override" : demand.targetSource;

      return {
        key: row.key,
        vaccineName: row.vaccineName,
        ndc: row.ndc,
        group: row.group,
        active: row.active,
        upcoming7d: row.upcoming7d,
        given7d: row.given7d,
        onHand: row.onHand,
        onHandAsOf: row.onHandAsOf,
        unitSize: row.unitSize,
        scheduledDemand: demand.scheduledDemand,
        trendDemand: demand.trendDemand,
        recommendedTarget: demand.demandTarget,
        targetOnHand: ndcOverride ?? null,
        effectiveTarget,
        targetSource,
        order: Math.max(0, effectiveTarget - (row.onHand ?? 0)),
      };
    });

    return NextResponse.json({
      onHandLastReceivedAt,
      targetsPending,
      walkInPct,
      walkInPctPending,
      trendUnavailable,
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
