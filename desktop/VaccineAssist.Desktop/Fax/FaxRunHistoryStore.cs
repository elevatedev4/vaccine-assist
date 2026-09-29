using System.IO;
using System.Text.Json;
using VaccineAssist.Desktop.Logging;

namespace VaccineAssist.Desktop.Fax;

/// <summary>
/// Reads back the fax\runs\*.json files FaxRunOrchestrator.
/// WriteRunSummaryFile already writes on every run — V-T65 R5's Send
/// History section (Views/FaxSendWindow.xaml, Will's brief: "Need to also
/// be able to get back to send history"). Read-only: this class never
/// writes anything, it just lists what's already there, newest first.
/// </summary>
public interface IFaxRunHistoryStore
{
    IReadOnlyList<FaxRunSummary> LoadRecent(int max = 50);
}

public sealed class FaxRunHistoryStore : IFaxRunHistoryStore
{
    private readonly string _runsDir;

    /// <param name="runsDir">The fax\runs\ directory — pass
    /// FaxRunOrchestrator.FaxRootDir + "runs" in production so this always
    /// reads from the same root the orchestrator writes to.</param>
    public FaxRunHistoryStore(string runsDir)
    {
        _runsDir = runsDir;
    }

    public IReadOnlyList<FaxRunSummary> LoadRecent(int max = 50)
    {
        try
        {
            if (!Directory.Exists(_runsDir))
            {
                return Array.Empty<FaxRunSummary>();
            }

            var summaries = new List<(DateTime SortKey, FaxRunSummary Summary)>();
            foreach (var path in Directory.GetFiles(_runsDir, "*.json"))
            {
                try
                {
                    var json = File.ReadAllText(path);
                    var summary = JsonSerializer.Deserialize<FaxRunSummary>(json);
                    if (summary is not null)
                    {
                        summaries.Add((summary.RunAtUtc, summary));
                    }
                }
                catch (Exception ex)
                {
                    // One unreadable/corrupt run file must never hide the
                    // rest of the history — same tolerant-by-design posture
                    // as every other file-backed store in this app.
                    AppFileLog.LogException($"FaxRunHistoryStore.LoadRecent({path})", ex);
                }
            }

            return summaries
                .OrderByDescending(s => s.SortKey)
                .Take(max)
                .Select(s => s.Summary)
                .ToList();
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("FaxRunHistoryStore.LoadRecent", ex);
            return Array.Empty<FaxRunSummary>();
        }
    }
}
