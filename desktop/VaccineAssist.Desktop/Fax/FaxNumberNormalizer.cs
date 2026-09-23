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

    /// <summary>Last 4 digits only — the ONE fax-number form this app
    /// ever logs or writes to the ledger (Will's brief: "log ... fax
    /// last-4 only").</summary>
    public static string Last4(string? value)
    {
        var digits = StripToDigits(value);
        return digits.Length <= 4 ? digits : digits[^4..];
    }
}
