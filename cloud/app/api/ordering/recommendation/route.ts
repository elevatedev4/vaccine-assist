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
import { compositeNameToMatchableBase } from "@/lib/appointment-table";
import { env } from "@/lib/env";
import { matchVaccineName, type CatalogVaccine } from "@/lib/vaccine-matching";
import { buildRecommendationRow } from "@/lib/ordering-recommendation";

/**
 * Ordering tab recommendation endpoint (V-ordering, 2026-08-19/20).
 * GET, authed exactly like every other desktop-facing route
 * (requireAuthenticatedUser — see cloud/app/api/vaccines/route.ts).
 *
 * For each ACTIVE catalog vaccine, combines:
 *   - upcoming7d: scheduled Acuity appointment count over [today,
 *     today+6] (7 days inclusive), Chicago time — reuses the SAME
 *     fetchAppointmentTypes/fetchAppointmentsForRange/aggregateAppointmentCounts
 *     path and acuity_poll_cache cache as app/api/acuity/poll/route.ts,
 *     rather than re-fetching Acuity from scratch on every call.
 *   - onHand / onHandAsOf: the latest `on_hand_count` row for that
 *     vaccine where matched = true (see supabase/migrations/0006), or
 *     null/null if none exists yet.
 *   - recommendedOrder: see lib/ordering-recommendation.ts.
 *
 * NO administered-doses field: there is no administration-tracking
 * table/endpoint anywhere in this schema (vaccination records live in
 * PioneerRx, not this app) — see lib/ordering-recommendation.ts's doc
 * comment.
 *
 * RESPONSE CONTRACT (locked down — the desktop Ordering tab depends on
 * this exact shape):
 *   {
 *     "onHandLastReceivedAt": "2026-08-19T13:00:00.000Z" | null,  // latest received_at across ANY matched on_hand_count row
 *     "rows": [
 *       {
 *         "vaccineId": "uuid",
 *         "vaccineName": "string",
 *         "upcoming7d": 12,
 *         "onHand": 8,
 *         "onHandAsOf": "2026-08-19T13:00:00.000Z" | null,
 *         "recommendedOrder": 5
 *       }
 *     ]
 *   }
 */
export async function GET(request: Request) {
  const auth = await requireAuthenticatedUser(request);
  if ("error" in auth) return auth.error;

  try {
    const supabase = getSupabaseServerClient();

    const { data: vaccinesData, error: vaccinesError } = await supabase
      .from("vaccine")
      .select("id, name, short_code")
      .eq("active", true)
      .order("name", { ascending: true });

    if (vaccinesError) {
      console.error("GET /api/ordering/recommendation: failed to load vaccine catalog", vaccinesError);
      return NextResponse.json({ error: "Failed to load vaccine catalog." }, { status: 500 });
    }

    const catalog: CatalogVaccine[] = vaccinesData ?? [];

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

        for (const { vaccineName, count } of counts) {
          // COVID/Flu counts arrive as an aggregation composite ("COVID ·
          // Pfizer · 65+", "Flu · 3-64" — see covidCompositeName/
          // fluCompositeName in lib/acuity-client.ts) that doesn't
          // resemble any catalog name on its own. Strip it down to a
          // matchable brand/product string (age is never relevant to an
          // order quantity) before handing it to the catalog matcher —
          // see compositeNameToMatchableBase's doc comment for exactly
          // what this fixes and its documented brand-ambiguity tradeoffs.
          // A non-composite name passes through unchanged.
          const match = matchVaccineName(compositeNameToMatchableBase(vaccineName), catalog);
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

    const { data: onHandRows, error: onHandError } = await supabase
      .from("on_hand_count")
      .select("vaccine_id, quantity, received_at")
      .eq("matched", true)
      .order("received_at", { ascending: false });

    if (onHandError) {
      console.error("GET /api/ordering/recommendation: failed to load on-hand counts", onHandError);
      return NextResponse.json({ error: "Failed to load on-hand counts." }, { status: 500 });
    }

    // Rows are ordered received_at DESC across every vaccine, so the
    // first row seen for a given vaccine_id is that vaccine's latest —
    // one query instead of one-per-vaccine.
    const latestOnHandByVaccineId = new Map<string, { quantity: number | null; receivedAt: string }>();
    let onHandLastReceivedAt: string | null = null;
    for (const row of onHandRows ?? []) {
      if (onHandLastReceivedAt === null) onHandLastReceivedAt = row.received_at;
      if (!row.vaccine_id) continue;
      if (!latestOnHandByVaccineId.has(row.vaccine_id)) {
        latestOnHandByVaccineId.set(row.vaccine_id, { quantity: row.quantity, receivedAt: row.received_at });
      }
    }

    const rows = catalog.map((vaccine) => {
      const upcoming7d = upcomingByVaccineId.get(vaccine.id) ?? 0;
      const onHandEntry = latestOnHandByVaccineId.get(vaccine.id) ?? null;
      return buildRecommendationRow({
        vaccineId: vaccine.id,
        vaccineName: vaccine.name,
        upcoming7d,
        onHand: onHandEntry?.quantity ?? null,
        onHandAsOf: onHandEntry?.receivedAt ?? null,
      });
    });

    return NextResponse.json({ onHandLastReceivedAt, rows });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Supabase is not configured." },
      { status: 503 }
    );
  }
}
