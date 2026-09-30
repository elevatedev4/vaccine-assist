using System;
using System.Globalization;

namespace VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;

/// <summary>
/// V-T41 R6 (Will's brief, item 1: "UIA AutomationId/ClassName +
/// readback"): pure value-comparison logic for InputOriginAndDaysSupplyStep's
/// post-SetValue verification — same "SetValue succeeding only proves
/// PioneerRx accepted the UIA call, not that it kept the value" posture as
/// InputLotAndExpirationStep.VerifyFieldTyped, but normalized for the two
/// specific ways a readback can legitimately differ from what was typed
/// here without PioneerRx actually having rejected/reformatted it:
///   - Origin is plausibly a coded ComboBox (e.g. displaying "9 - Other"
///     rather than the bare label "Other" SetValue was given).
///   - Days supply is a numeric field where "1", "1.0", and "01" are all
///     the same value.
/// A plain case-insensitive trim (InputLotAndExpirationStep's own
/// comparison) would false-positive-fail both of those. No FlaUI/UIA
/// dependency — see OriginAndDaysSupplyReadbackTests.cs.
/// </summary>
public static class OriginAndDaysSupplyReadback
{
    /// <summary>Matches on an exact (trimmed, case-insensitive) equal, OR
    /// when `actual` ends with a "- expected"/"-expected" suffix (the
    /// "coded value - label" shape a PioneerRx combo box readback might
    /// show). Blank/null `actual` never matches (a field that reads back
    /// empty was NOT actually set, whatever SetValue reported).</summary>
    public static bool OriginMatches(string? actual, string expected)
    {
        var normalizedActual = (actual ?? string.Empty).Trim();
        var normalizedExpected = (expected ?? string.Empty).Trim();

        if (normalizedActual.Length == 0 || normalizedExpected.Length == 0)
        {
            return false;
        }

        if (string.Equals(normalizedActual, normalizedExpected, StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        var dashIndex = normalizedActual.LastIndexOf('-');
        if (dashIndex >= 0 && dashIndex < normalizedActual.Length - 1)
        {
            var afterDash = normalizedActual[(dashIndex + 1)..].Trim();
            if (string.Equals(afterDash, normalizedExpected, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>Matches on an exact (trimmed) equal, OR when both sides
    /// parse as the same number (invariant culture — "1", "1.0", "01" all
    /// equal 1). Blank/null `actual` never matches.</summary>
    public static bool DaysSupplyMatches(string? actual, string expected)
    {
        var normalizedActual = (actual ?? string.Empty).Trim();
        var normalizedExpected = (expected ?? string.Empty).Trim();

        if (normalizedActual.Length == 0 || normalizedExpected.Length == 0)
        {
            return false;
        }

        if (string.Equals(normalizedActual, normalizedExpected, StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        if (double.TryParse(normalizedActual, NumberStyles.Float, CultureInfo.InvariantCulture, out var actualNumber) &&
            double.TryParse(normalizedExpected, NumberStyles.Float, CultureInfo.InvariantCulture, out var expectedNumber))
        {
            return Math.Abs(actualNumber - expectedNumber) < 0.0001;
        }

        return false;
    }
}
