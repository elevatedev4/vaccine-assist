using System.Text.Json;

namespace VaccineAssist.Desktop.Fax;

/// <summary>Tiny runtime-state file (NOT user configuration — kept
/// separate from settings.json/FaxSettings on purpose) recording the
/// local date the daily run last completed, so FaxScheduleDecision's
/// once-per-day guard survives an app restart. %AppData%\VaccineAssist\fax\last-run.json.</summary>
public interface IFaxRunMarker
{
    DateOnly? LoadLastRunLocalDate();
    void SaveLastRunLocalDate(DateOnly date);
}

public sealed class FaxRunMarker : IFaxRunMarker
{
    private readonly string _filePath;

    public FaxRunMarker()
        : this(Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "VaccineAssist", "fax", "last-run.json"))
    {
    }

    /// <summary>Injectable seam for unit tests.</summary>
    public FaxRunMarker(string filePath)
    {
        _filePath = filePath;
    }

    public DateOnly? LoadLastRunLocalDate()
    {
        try
        {
            if (!File.Exists(_filePath)) return null;
            var json = File.ReadAllText(_filePath);
            var dto = JsonSerializer.Deserialize<MarkerDto>(json);
            return dto?.LastRunLocalDate;
        }
        catch
        {
            return null;
        }
    }

    public void SaveLastRunLocalDate(DateOnly date)
    {
        var directory = Path.GetDirectoryName(_filePath);
        if (!string.IsNullOrEmpty(directory) && !Directory.Exists(directory))
        {
            Directory.CreateDirectory(directory);
        }

        var json = JsonSerializer.Serialize(new MarkerDto { LastRunLocalDate = date });
        File.WriteAllText(_filePath, json);
    }

    private sealed class MarkerDto
    {
        public DateOnly LastRunLocalDate { get; set; }
    }
}
