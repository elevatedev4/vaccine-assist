namespace VaccineAssist.Desktop.Fax;

/// <summary>Which (date, vaccine) pair already exists in FaxFileLedger,
/// and what it looked like the last time it was sent — never a patient
/// identifier (see FaxDuplicateDetector's own doc comment).</summary>
public sealed record FaxDuplicateMatch(
    string AdministeredDate,
    string VaccineName,
    int NewCount,
    int PreviouslySentCount,
    DateTime PreviouslySentRunAtUtc);

/// <summary>Will's choice once FaxDuplicateDetector finds one or more
/// duplicate (date, vaccine) pairs in a picked file — see
/// FaxSendCoordinator.ConfirmDuplicates/Views/FaxDuplicateConfirmWindow.</summary>
public enum FaxDuplicateChoice
{
    /// <summary>Send every row, including the duplicates.</summary>
    SendAll,

    /// <summary>Send only the rows whose (date, vaccine) pair is NOT
    /// already in the ledger.</summary>
    SendOnlyNew,
}

/// <summary>
/// V-T65 R6 (Will, verbatim, 2026-09-29): "How is the app determining
/// what has already been sent? We can't store patient name ... If we
/// can't find a good way to actually skip, we should just store the
/// administration dates, quantity on each date, and look for duplicates
/// that way, then show an alert." Replaces the old per-row SHA-256
/// fingerprint dedupe (RowFingerprint/ImportLedger/the file-hash refusal
/// in FaxFileLedger) with exactly that: pure, static, patient-data-free
/// grouping/matching over AdministeredDate + VaccineName + a row count.
/// </summary>
public static class FaxDuplicateDetector
{
    /// <summary>The (date, vaccine) matching key for one record —
    /// normalized (trimmed, uppercased) so casing/whitespace differences
    /// between two exports of the same administration still match.</summary>
    public static (string Date, string VaccineKey) KeyFor(ImmunizationRecord record) =>
        (record.AdministeredDate.ToString("yyyy-MM-dd"), NormalizeVaccine(record.VaccineName));

    public static string NormalizeVaccine(string? vaccineName) => (vaccineName ?? "").Trim().ToUpperInvariant();

    /// <summary>Groups records by (date, vaccine) -> row count — the exact
    /// shape FaxFileLedger.RecordRun persists and FindDuplicates compares
    /// against. VaccineName here keeps its original (trimmed) casing for
    /// display; matching uses NormalizeVaccine, not this string.</summary>
    public static List<FaxSentDateEntry> Summarize(IEnumerable<ImmunizationRecord> records) =>
        records
            .GroupBy(KeyFor)
            .Select(g => new FaxSentDateEntry
            {
                AdministeredDate = g.Key.Date,
                VaccineName = g.First().VaccineName.Trim(),
                Count = g.Count(),
            })
            .OrderBy(e => e.AdministeredDate).ThenBy(e => e.VaccineName)
            .ToList();

    /// <summary>Every (date, vaccine) pair in <paramref name="newEntries"/>
    /// that's already recorded in a past sent run — when a pair was sent
    /// more than once, the MOST RECENT matching run wins (freshest "sent
    /// on" date to show Will).</summary>
    public static List<FaxDuplicateMatch> FindDuplicates(
        IReadOnlyList<FaxSentDateEntry> newEntries,
        IReadOnlyList<FaxSentRunEntry> ledgerRuns)
    {
        var matches = new List<FaxDuplicateMatch>();

        foreach (var newEntry in newEntries)
        {
            var newKey = (newEntry.AdministeredDate, NormalizeVaccine(newEntry.VaccineName));
            FaxSentRunEntry? bestRun = null;
            FaxSentDateEntry? bestEntry = null;

            foreach (var run in ledgerRuns)
            {
                foreach (var sentEntry in run.Entries)
                {
                    var sentKey = (sentEntry.AdministeredDate, NormalizeVaccine(sentEntry.VaccineName));
                    if (!sentKey.Equals(newKey)) continue;

                    if (bestRun is null || run.RunAtUtc > bestRun.RunAtUtc)
                    {
                        bestRun = run;
                        bestEntry = sentEntry;
                    }
                }
            }

            if (bestRun is not null && bestEntry is not null)
            {
                matches.Add(new FaxDuplicateMatch(
                    newEntry.AdministeredDate,
                    newEntry.VaccineName,
                    newEntry.Count,
                    bestEntry.Count,
                    bestRun.RunAtUtc));
            }
        }

        return matches;
    }

    /// <summary>"Send only new rows" — every record whose (date, vaccine)
    /// pair is NOT one of <paramref name="duplicates"/>.</summary>
    public static List<ImmunizationRecord> FilterOutDuplicates(
        IEnumerable<ImmunizationRecord> records,
        IReadOnlyList<FaxDuplicateMatch> duplicates)
    {
        var dupKeys = new HashSet<(string Date, string VaccineKey)>(
            duplicates.Select(d => (d.AdministeredDate, NormalizeVaccine(d.VaccineName))));
        return records.Where(r => !dupKeys.Contains(KeyFor(r))).ToList();
    }
}
