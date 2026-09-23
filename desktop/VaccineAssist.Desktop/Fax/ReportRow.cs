namespace VaccineAssist.Desktop.Fax;

/// <summary>One raw row of an imported report file — header text (as it
/// appeared in the file) -> cell text, case-insensitive lookup. The
/// intermediate shape between ReportRowReader (file format-specific) and
/// ReportRowParser (FaxColumnMap-driven, format-agnostic).</summary>
public sealed class ReportRow
{
    private readonly IReadOnlyDictionary<string, string> _values;

    public ReportRow(IReadOnlyDictionary<string, string> values)
    {
        var copy = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var kvp in values)
        {
            copy[kvp.Key] = kvp.Value;
        }
        _values = copy;
    }

    public string? Get(string? header)
    {
        if (string.IsNullOrWhiteSpace(header)) return null;
        return _values.TryGetValue(header, out var value) && !string.IsNullOrWhiteSpace(value) ? value.Trim() : null;
    }
}
