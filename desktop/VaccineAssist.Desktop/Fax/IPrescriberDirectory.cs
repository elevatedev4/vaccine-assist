namespace VaccineAssist.Desktop.Fax;

public interface IPrescriberDirectory
{
    IReadOnlyList<PrescriberDirectoryEntry> Load();

    void Save(IReadOnlyList<PrescriberDirectoryEntry> entries);

    /// <summary>Looks up a fax number by NPI first (when present), then by
    /// normalized name — same priority ImmunizationRecord.PrescriberKey/
    /// PrescriberDirectoryEntry.Key encode. Null when nothing matches.</summary>
    string? TryGetFaxNumber(string? prescriberName, string? prescriberNpi);
}
