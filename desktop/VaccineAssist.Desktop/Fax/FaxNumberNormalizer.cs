namespace VaccineAssist.Desktop.Fax;

/// <summary>
/// Fax-number normalization/validation shared by the Settings window's
/// save (Will's brief: "Saving validates fax numbers (digits, 10–11)"),
/// PrescriberDirectory, and SrFaxClient's sToFaxNumber field (digits
/// only, per SRFax's API).
/// </summary>
public static class FaxNumberNormalizer
{
    /// <summary>Strips everything but digits. "" in, "" out.</summary>
    public static string StripToDigits(string? value)
    {
        if (string.IsNullOrEmpty(value)) return "";
        return new string(value.Where(char.IsDigit).ToArray());
    }

    /// <summary>10 digits (area code + number), or 11 digits starting
    /// with a leading 1 (US/Canada long-distance prefix) — matches the
    /// brief's "digits only, 10–11" and SRFax's sToFaxNumber expectation.</summary>
    public static bool IsValid(string? value)
    {
        var digits = StripToDigits(value);
        return digits.Length == 10 || (digits.Length == 11 && digits[0] == '1');
    }

    /// <summary>Digits-only form for SRFax's sToFaxNumber, or null when
    /// the input isn't a valid 10/11-digit number.</summary>
    public static string? ToDialableOrNull(string? value)
    {
        var digits = StripToDigits(value);
        return IsValid(digits) ? digits : null;
    }

    /// <summary>"+1" + the 10-digit number — Notifyre's expected E.164
    /// form for a US/Canada fax number (its Send Fax recipient "Value"
    /// field, e.g. "+61234356789" in AU docs examples), or null when the
    /// input isn't a valid 10/11-digit number (same validity rule as
    /// ToDialableOrNull).</summary>
    public static string? ToE164OrNull(string? value)
    {
        var digits = StripToDigits(value);
        if (!IsValid(digits)) return null;
        var tenDigits = digits.Length == 11 ? digits[1..] : digits;
        return "+1" + tenDigits;
    }

    /// <summary>Last 4 digits only — the ONE fax-number form this app
    /// ever logs or writes to the ledger (Will's brief: "log ... fax
    /// last-4 only").</summary>
    public static string Last4(string? value)
    {
        var digits = StripToDigits(value);
        return digits.Length <= 4 ? digits : digits[^4..];
    }

    /// <summary>"(###) ###-####" for a valid 10/11-digit US/Canada number
    /// (fax-report-layout brief, 2026-09-28: the letter's "To:" block
    /// shows the fax number actually being sent to, formatted
    /// consistently regardless of how the report/directory had it typed —
    /// "(###) ###-####", digits-only, or dashed all normalize to the
    /// same display form). Falls back to the trimmed raw input when it
    /// isn't a valid 10/11-digit number, so an already-odd value still
    /// shows SOMETHING rather than going blank.</summary>
    public static string ToDisplay(string? value)
    {
        var digits = StripToDigits(value);
        if (digits.Length == 11 && digits[0] == '1')
        {
            digits = digits[1..];
        }

        return digits.Length == 10
            ? $"({digits[..3]}) {digits.Substring(3, 3)}-{digits[6..]}"
            : (value ?? "").Trim();
    }
}
