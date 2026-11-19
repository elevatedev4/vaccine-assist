namespace VaccineAssist.Desktop.BarcodeCheck;

/// <summary>
/// In-memory lookup of the loaded numbers. A scan matches on the exact
/// digit string; a number that differs only by leading zeros also matches
/// ("0012345" finds "12345" and vice versa). Backed by a HashSet, so each
/// scan is instant however long the list is. Lives only as long as the
/// Barcode check window — Clear() empties it.
/// </summary>
public sealed class BarcodeMatcher
{
    private readonly HashSet<string> _keys = new(StringComparer.Ordinal);

    /// <summary>Distinct numbers held (after leading zeros are ignored).</summary>
    public int Count => _keys.Count;

    public void Load(IEnumerable<string> numbers)
    {
        _keys.Clear();
        foreach (var number in numbers)
        {
            var key = ToKey(number);
            if (key is not null)
            {
                _keys.Add(key);
            }
        }
    }

    public void Clear() => _keys.Clear();

    /// <summary>True when the scanned text (trimmed) is in the list.
    /// Anything that is not purely digits is never a match.</summary>
    public bool Contains(string? scanned)
    {
        var key = ToKey(scanned);
        return key is not null && _keys.Contains(key);
    }

    /// <summary>Trimmed digits with leading zeros removed ("000" -> "0");
    /// null for blank or non-digit text.</summary>
    internal static string? ToKey(string? text)
    {
        if (text is null)
        {
            return null;
        }

        var trimmed = text.Trim();
        if (trimmed.Length == 0)
        {
            return null;
        }

        foreach (var ch in trimmed)
        {
            if (ch < '0' || ch > '9')
            {
                return null;
            }
        }

        var stripped = trimmed.TrimStart('0');
        return stripped.Length == 0 ? "0" : stripped;
    }
}
