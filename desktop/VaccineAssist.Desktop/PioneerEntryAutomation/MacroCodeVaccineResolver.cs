using System;
using System.Collections.Generic;
using System.Linq;
using VaccineAssist.Desktop.Models;

namespace VaccineAssist.Desktop.PioneerEntryAutomation;

/// <summary>
/// V-T41 R5 (Will's brief, item 3): finds the real Vaccine catalog row a
/// MacroCodeParser.TryParse result's ShortCode refers to, so the Ctrl+
/// Keypad 7 flow can build a full VaccineEntryPayload (NDC/Quantity/
/// Directions/Name — none of which the macro-codes picker's postMessage
/// contract carries directly). Pure, no HTTP dependency — MainWindow calls
/// IVaccineApiService.GetVaccinesAsync() itself and hands the result in
/// here; see MacroCodeVaccineResolverTests.cs.
/// </summary>
public static class MacroCodeVaccineResolver
{
    /// <summary>Case-insensitive, trimmed match against Vaccine.ShortCode —
    /// same de-dupe key cloud/lib/macro-codes.ts's buildMacroRows already
    /// uses (`v.short_code!.trim().toLowerCase()`). Null when no vaccine in
    /// `vaccines` has this short code on file.</summary>
    public static Vaccine? FindByShortCode(IEnumerable<Vaccine> vaccines, string shortCode)
    {
        var target = (shortCode ?? "").Trim();
        if (target.Length == 0) return null;

        return vaccines.FirstOrDefault(v =>
            string.Equals((v.ShortCode ?? "").Trim(), target, StringComparison.OrdinalIgnoreCase));
    }
}
