using System.Collections.ObjectModel;
using System.Windows.Input;
using VaccineAssist.Desktop.Common;
using VaccineAssist.Desktop.Fax;
using VaccineAssist.Desktop.Settings;

namespace VaccineAssist.Desktop.ViewModels;

/// <summary>
/// Backs Views/FaxRunSummaryWindow.xaml. Will's brief: "counts: imported
/// rows, patients, sent, in-process, failed, needs-fax-number, with a
/// per-row grid ... Failed faxes get a Retry action in the summary window
/// (explicit user click only)."
/// </summary>
public sealed class FaxRunSummaryViewModel : ObservableObject
{
    private readonly FaxRunOrchestrator _orchestrator;
    private readonly AppSettings _settings;
    private string? _statusMessage;

    public FaxRunSummaryViewModel(FaxRunSummary summary, FaxRunOrchestrator orchestrator, AppSettings settings)
    {
        Summary = summary;
        _orchestrator = orchestrator;
        _settings = settings;

        Rows = new ObservableCollection<FaxRunRowSummary>(summary.Rows);
        RetryCommand = new AsyncRelayCommand<FaxRunRowSummary>(RetryAsync, row =>
            row is not null && string.Equals(row.Status, nameof(FaxLedgerStatus.Failed), StringComparison.OrdinalIgnoreCase));
    }

    public FaxRunSummary Summary { get; }

    public ObservableCollection<FaxRunRowSummary> Rows { get; }

    public string? StatusMessage
    {
        get => _statusMessage;
        private set => SetProperty(ref _statusMessage, value);
    }

    public ICommand RetryCommand { get; }

    private async Task RetryAsync(FaxRunRowSummary? row)
    {
        if (row is null) return;

        var succeeded = await _orchestrator.RetryFailedAsync(row.LedgerEntryId, _settings.Fax);
        if (succeeded)
        {
            row.Status = nameof(FaxLedgerStatus.InProcess);
            row.Error = null;
            StatusMessage = $"Requeued fax for {row.PatientInitials}.";
        }
        else
        {
            StatusMessage = $"Retry failed for {row.PatientInitials} — check the prescriber's fax number in Fax settings.";
        }

        // Rebuild the row so the DataGrid (bound to Rows, not directly to
        // Summary.Rows) picks up the mutated Status/Error — FaxRunRowSummary
        // is a plain mutable class, not an ObservableObject, since it's
        // also what gets serialized verbatim to runs\<timestamp>.json.
        var index = Rows.IndexOf(row);
        if (index >= 0)
        {
            Rows[index] = row;
        }
    }
}
