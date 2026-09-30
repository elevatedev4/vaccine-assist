namespace VaccineAssist.Desktop.PioneerEntryAutomation;

/// <summary>ShortCode/LotNumber/ExpirationMacroFormat parsed out of a
/// MacroCodesWindow "vaccine-assist:macro-copied" message's `code` field —
/// see MacroCodeParser.TryParse's own doc comment for the exact format.
/// ShortCode is always non-blank on a successful parse; LotNumber/
/// ExpirationMacroFormat may be blank (an incomplete lot on file for that
/// vaccine — cloud/lib/macro-codes.ts's buildMacroCode still emits the
/// segment, just empty).</summary>
public readonly record struct ParsedMacroCode(string ShortCode, string LotNumber, string ExpirationMacroFormat);

/// <summary>
/// V-T41 R5 (Will's brief, item 3): the Ctrl+Keypad 7 flow now reuses the
/// Ctrl+Keypad 2 age+macro-codes picker, then runs THIS app's own
/// PioneerEntryAutomation against the picked product instead of sending a
/// synthetic Ctrl+NumPad5. The picker only ever hands back the macro TEXT
/// (MacroCodesWindow's onCodeCopied callback — see cloud/lib/macro-embed.ts's
/// MacroCopiedMessage.code) — never a vaccine id/NDC directly — so this
/// parses that text back into the pieces PioneerEntryAutomation needs.
///
/// FORMAT: cloud/lib/macro-codes.ts's buildMacroCode always calls
/// buildMacroCode with doseCount: 1 for the real per-dose MacroRow it
/// builds (see buildMacroRows), so the emitted text is always exactly
/// "&lt;vaccine.short_code&gt;,&lt;lot&gt;,&lt;MMDDYYYY&gt;" — the SAME
/// vaccine short_code the picked row's own `vaccine` table record carries
/// (never a dose-number suffix), which is exactly the key
/// MacroCodeVaccineResolver needs to look the real Vaccine row up via
/// IVaccineApiService.GetVaccinesAsync(). This is also byte-identical to
/// the old macro-era clipboard format VaccineEntryPayload.ToClipboardPayload
/// already documents ("code,lot,exp").
///
/// Pure, no HTTP/UIA dependency — directly unit-testable (see
/// MacroCodeParserTests.cs).
/// </summary>
public static class MacroCodeParser
{
    /// <summary>Null for a null/blank/whitespace-only input, or one with no
    /// non-blank short-code segment. Otherwise splits on the first two
    /// commas — LotNumber/ExpirationMacroFormat default to "" when the
    /// input has fewer than 3 comma-separated segments (should not happen
    /// for a real macro-codes payload, but never throws either way).</summary>
    public static ParsedMacroCode? TryParse(string? macroText)
    {
        if (string.IsNullOrWhiteSpace(macroText))
        {
            return null;
        }

        var parts = macroText.Split(',');
        var shortCode = parts[0].Trim();
        if (shortCode.Length == 0)
        {
            return null;
        }

        var lotNumber = parts.Length > 1 ? parts[1].Trim() : "";
        var expirationMacroFormat = parts.Length > 2 ? parts[2].Trim() : "";

        return new ParsedMacroCode(shortCode, lotNumber, expirationMacroFormat);
    }
}
