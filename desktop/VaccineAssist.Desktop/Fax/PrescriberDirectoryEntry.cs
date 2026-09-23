namespace VaccineAssist.Desktop.Fax;

/// <summary>One row of the editable prescriber-fax-number table (Will's
/// brief: "a local editable table ... keyed by NPI (or normalized name
/// when no NPI) -> fax number"). Backs the Settings window's grid AND
/// the on-disk prescribers.json.</summary>
public sealed class PrescriberDirectoryEntry
{
    public string Name { get; set; } = "";
    public string? Npi { get; set; }
    public string FaxNumber { get; set; } = "";

    /// <summary>Matches ImmunizationRecord.PrescriberKey's own logic —
    /// the two MUST agree, or a saved directory entry would never match
    /// the report row it was meant for.</summary>
    public string Key =>
        !string.IsNullOrWhiteSpace(Npi)
            ? "npi:" + FaxNumberNormalizer.StripToDigits(Npi)
            : "name:" + Name.Trim().ToUpperInvariant();
}
