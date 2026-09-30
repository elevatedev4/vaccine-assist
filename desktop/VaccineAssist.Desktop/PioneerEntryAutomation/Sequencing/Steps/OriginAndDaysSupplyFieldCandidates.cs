using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;

namespace VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;

/// <summary>
/// V-T41 R6 (Will's answer, 2026-09-30 1:11pm, verbatim): "Origin needs to
/// be set to Other and Days supply needs to be set to 1." Same
/// "fixed-candidate-list, then keyword fallback" shape as
/// DirectionsFieldCandidates (see that class's own doc comment for the
/// full rationale) — reused here rather than shared, since the two fields
/// have different candidate ids AND different keyword-fallback control
/// types — see the "CONTROL TYPE FINDING" paragraph below for exactly
/// what each field's <c>KeywordControlTypes</c> list is and why.
///
/// ORIGIN — NO CONFIRMED AutomationId: unlike every id InputOriginAndDaysSupplyStep's
/// sibling steps use (uxLotNumber, uxQuantityPrescribed, uxPrescribedItemQuickSearch,
/// etc. — each confirmed against a live "Add New Rx" UIA dump), no dump has
/// ever shown an Origin field at all. <see cref="OriginAutomationIds"/> are
/// PLACEHOLDER guesses following this app's own "ux" + PascalCase naming
/// convention (same posture InputDirectionsStep.DirectionsAutomationId
/// started from before DirectionsFieldCandidates existed) — InputOriginAndDaysSupplyStep
/// treats a miss on every one of these (and the keyword fallback below) as
/// expected, not a bug: it logs one field dump and moves on rather than
/// failing the whole vaccine entry over a still-unconfirmed field.
///
/// REVIEWER FIX (REQUEST_CHANGES, V-T41 R6 round 2): the Origin keyword
/// fallback used to be a plain Contains("origin") check — "origin" is a
/// substring of "original," so an enabled "Original Rx"/"Original Date"/
/// "Original Fill" field (plausible on this exact screen — PioneerRx's Add
/// New Rx panel is literally titled "Original" per InputVaccineCodeStep's
/// own doc comment: "Original" Rx details panel's prescribed-drug
/// section") would have matched, gotten SetValue("Other")+confirmed by
/// reading its own wrong value back, and silently corrupted that field
/// while reporting success. Origin keyword matching now requires an EXACT
/// (case-insensitive) TOKEN equal to "origin" — see
/// <see cref="Tokenize"/> — not a substring anywhere in the text, so
/// "Original"/"Originator"/"uxOriginalDate" never match while "Origin"/
/// "Rx Origin"/"uxOriginCombo" still do. Applied to BOTH keyword sets here
/// (Origin AND Days Supply) for consistency, even though "days supply"/
/// "day supply" don't have an obvious same-prefix collision today — token
/// matching is strictly safer and costs nothing. (The old bare
/// "dayssupply" keyword is dropped entirely — see DaysSupplyKeywords' own
/// doc comment for why it can't usefully match under token-sequence
/// matching anyway.)
///
/// CONTROL TYPE FINDING (reviewer asked: does this codebase's own evidence
/// show PioneerRx renders a coded/selector field as ComboBox?): searched
/// every live-UIA-dump-backed doc comment in this Sequencing/Steps folder.
/// The prescriber/drug quick-search fields (SelectPrescriberStep,
/// InputVaccineCodeStep) are plain Edit controls with no popup. The ONLY
/// coded/selector-style field ever actually captured live is the
/// "Priority" dialog (SendF3AndDismissPreEntryDialogsStep's "ROUND 6 — F12
/// STILL DOESN'T SAVE, WITH A LIVE DUMP THIS TIME" doc comment, Will's
/// 2026-09-29 11:14 dump) — and it turned out to be an Edit search box
/// (AutomationId 'uxPrioritySearch') with type-ahead into a SEPARATE
/// top-level "Auto-Suggest Dropdown" popup window, explicitly "NOT a
/// classic ComboBox with a 'ComboLBox' popup, which is what every prior
/// round assumed and built for" (that file's own words). So the evidence
/// in THIS codebase points AWAY from ComboBox, not toward it —
/// <see cref="OriginKeywordControlTypes"/> keeps Edit (now evidence-backed
/// as this app's actual coded-selector shape) and keeps ComboBox too only
/// as a still-unconfirmed, cost-nothing-to-also-check possibility, rather
/// than narrowing to ComboBox-only as originally suggested.
///
/// DAYS SUPPLY — PARTIALLY CONFIRMED: "uxDaysSupply" itself is a real
/// AutomationId InputVaccineCodeStep's own doc comment already names (the
/// 2026-09-05 live dumps showed it auto-populating from the resolved drug
/// record, which is why no step has ever TYPED into it before now) — kept
/// first in <see cref="DaysSupplyAutomationIds"/> as the primary guess,
/// with the same keyword-fallback safety net as Origin in case the actual
/// "Add New Rx" screen uses a different id than whatever dump that comment
/// refers to.
///
/// PURE matcher, no FlaUI/UIA dependency — see
/// OriginAndDaysSupplyFieldCandidatesTests.cs.
/// </summary>
public static class OriginAndDaysSupplyFieldCandidates
{
    public static readonly IReadOnlyList<string> OriginAutomationIds = new[]
    {
        "uxOrigin",
        "uxRxOrigin",
        "uxOriginCode",
        "uxScriptOrigin",
    };

    public static readonly IReadOnlyList<string> DaysSupplyAutomationIds = new[]
    {
        "uxDaysSupply", // InputVaccineCodeStep's own doc comment — confirmed real, never typed into before now.
        "uxDaysSupplyPrescribed",
        "uxDaySupply",
    };

    private static readonly string[] OriginKeywords = { "origin" };

    /// <summary>No bare "dayssupply" (one run-together word) entry — under
    /// the token-sequence matching TryMatch now uses, a field's Name/
    /// AutomationId is tokenized on BOTH separators and camelCase
    /// boundaries (so "uxDaysSupply" -&gt; "ux","Days","Supply"), and
    /// "days supply" already matches that as a two-token subsequence; a
    /// single concatenated "dayssupply" keyword could only ever match
    /// literal unsegmented text no real WinForms AutomationId/label uses.</summary>
    private static readonly string[] DaysSupplyKeywords = { "days supply", "day supply" };

    /// <summary>Edit AND ComboBox — see this class's own "CONTROL TYPE
    /// FINDING" paragraph above: the only live-dump evidence in this
    /// codebase for a coded/selector field shows Edit (with a separate
    /// Auto-Suggest Dropdown popup), not ComboBox, so Edit stays as the
    /// evidence-backed choice; ComboBox is kept too only because it's
    /// still not positively ruled out.</summary>
    private static readonly string[] OriginKeywordControlTypes = { "Edit", "ComboBox" };

    /// <summary>Days supply is a plain numeric/text field, same shape as
    /// Quantity/Lot — no ComboBox expected.</summary>
    private static readonly string[] DaysSupplyKeywordControlTypes = { "Edit" };

    public static FieldDescriptor? TryMatchOrigin(IReadOnlyList<FieldDescriptor> candidates) =>
        TryMatch(candidates, OriginAutomationIds, OriginKeywords, OriginKeywordControlTypes);

    public static FieldDescriptor? TryMatchDaysSupply(IReadOnlyList<FieldDescriptor> candidates) =>
        TryMatch(candidates, DaysSupplyAutomationIds, DaysSupplyKeywords, DaysSupplyKeywordControlTypes);

    /// <summary>Same algorithm as DirectionsFieldCandidates.TryMatch: an
    /// exact (case-insensitive) AutomationId match against `ids`, checked
    /// in order across the whole candidate list before moving to the next
    /// id; failing that, the first candidate of one of `controlTypes` whose
    /// Name OR AutomationId contains one of `keywords` as an exact TOKEN
    /// SEQUENCE (see <see cref="HasKeywordTokenSequence"/> — REVIEWER FIX,
    /// this class's own doc comment: NOT a plain substring check anymore,
    /// so "origin" can never match "original") — but only when the
    /// candidate has a non-blank AutomationId (a Name-only match can't be
    /// re-found/acted on by AutomationId later). Null when nothing
    /// qualifies.</summary>
    private static FieldDescriptor? TryMatch(
        IReadOnlyList<FieldDescriptor> candidates, IReadOnlyList<string> ids, IReadOnlyList<string> keywords, IReadOnlyList<string> controlTypes)
    {
        foreach (var id in ids)
        {
            foreach (var candidate in candidates)
            {
                if (!string.IsNullOrEmpty(candidate.AutomationId) &&
                    string.Equals(candidate.AutomationId, id, StringComparison.OrdinalIgnoreCase))
                {
                    return candidate;
                }
            }
        }

        foreach (var candidate in candidates)
        {
            if (string.IsNullOrEmpty(candidate.AutomationId)) continue;
            if (candidate.ControlType is null ||
                !controlTypes.Contains(candidate.ControlType, StringComparer.OrdinalIgnoreCase))
            {
                continue;
            }

            if (keywords.Any(k => HasKeywordTokenSequence(candidate.Name, k) || HasKeywordTokenSequence(candidate.AutomationId, k)))
            {
                return candidate;
            }
        }

        return null;
    }

    /// <summary>
    /// REVIEWER FIX (REQUEST_CHANGES, V-T41 R6 round 2) — see this class's
    /// own doc comment for the live "Original Rx"/"original" false-positive
    /// this replaces. True when `keyword`'s own tokens (see
    /// <see cref="Tokenize"/> — e.g. "days supply" -&gt; "days","supply")
    /// appear as a CONTIGUOUS, case-insensitive subsequence somewhere in
    /// `text`'s tokens. A single-word keyword like "origin" is just the
    /// length-1 case of the same check — it only matches a text token that
    /// EQUALS "origin", never one that merely starts with it.
    /// </summary>
    private static bool HasKeywordTokenSequence(string? text, string keyword)
    {
        var textTokens = Tokenize(text);
        var keywordTokens = Tokenize(keyword);
        if (keywordTokens.Count == 0 || textTokens.Count < keywordTokens.Count)
        {
            return false;
        }

        for (var start = 0; start + keywordTokens.Count <= textTokens.Count; start++)
        {
            var allMatch = true;
            for (var i = 0; i < keywordTokens.Count; i++)
            {
                if (!string.Equals(textTokens[start + i], keywordTokens[i], StringComparison.OrdinalIgnoreCase))
                {
                    allMatch = false;
                    break;
                }
            }
            if (allMatch) return true;
        }

        return false;
    }

    /// <summary>Splits `text` first on any run of non-alphanumeric
    /// characters (spaces, dashes, underscores, punctuation — so "Rx
    /// Origin" -&gt; "Rx","Origin"), then further splits each piece on
    /// camelCase/PascalCase/acronym boundaries (so "uxOriginCombo" -&gt;
    /// "ux","Origin","Combo"; "uxDaysSupply" -&gt; "ux","Days","Supply";
    /// "UXOrigin" -&gt; "UX","Origin") — same general shape as any standard
    /// identifier tokenizer. Critically, "Original"/"Originator"/
    /// "uxOriginalDate" each tokenize to a single whole-word token
    /// ("Original"/"Originator"/...,"Original",...) that is never equal to
    /// "Origin," rather than "origin" appearing as a substring of it.
    /// Empty/null input returns an empty list.</summary>
    private static readonly Regex TokenPattern = new(@"[A-Z]+(?![a-z])|[A-Z][a-z]+|[a-z]+|[0-9]+", RegexOptions.Compiled);

    private static List<string> Tokenize(string? text)
    {
        if (string.IsNullOrEmpty(text)) return new List<string>();

        var tokens = new List<string>();
        foreach (var chunk in NonAlphanumeric.Split(text))
        {
            if (chunk.Length == 0) continue;
            foreach (Match m in TokenPattern.Matches(chunk))
            {
                tokens.Add(m.Value);
            }
        }
        return tokens;
    }

    private static readonly Regex NonAlphanumeric = new(@"[^A-Za-z0-9]+", RegexOptions.Compiled);
}
