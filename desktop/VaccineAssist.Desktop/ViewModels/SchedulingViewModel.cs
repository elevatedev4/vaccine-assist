using System;
using System.Collections.ObjectModel;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Input;
using VaccineAssist.Desktop.Common;
using VaccineAssist.Desktop.Models;
using VaccineAssist.Desktop.Services;

namespace VaccineAssist.Desktop.ViewModels;

/// <summary>
/// Backs the new Scheduling tab: pulls the pivoted appointment table from
/// GET /api/acuity/poll (via IVaccineApiService.GetAppointmentScheduleAsync)
/// and exposes it as day-rows/vaccine-columns for SchedulingView's DataGrid
/// (see AppointmentTablePivot for the actual transpose). Network call, so
/// this always has a loading/error/not-configured state — Acuity may not
/// be set up yet on the cloud side, and the request can simply fail.
/// </summary>
public sealed class SchedulingViewModel : ObservableObject
{
    private readonly IVaccineApiService _apiService;

    private bool _isBusy;
    private string? _errorMessage;
    private string? _statusMessage;
    private string? _asOf;

    public SchedulingViewModel(IVaccineApiService apiService)
    {
        _apiService = apiService;
        LoadCommand = new AsyncRelayCommand(LoadAsync, () => !IsBusy);
    }

    /// <summary>Day rows (including the trailing 7-day-sum row) for the
    /// DataGrid — SchedulingView.xaml.cs rebuilds the grid's columns
    /// whenever VaccineNames changes.</summary>
    public ObservableCollection<ScheduleDisplayRow> Rows { get; } = new();

    /// <summary>Unique vaccine names, in table order — one dynamically
    /// generated DataGrid column per entry.</summary>
    public ObservableCollection<string> VaccineNames { get; } = new();

    public bool IsBusy
    {
        get => _isBusy;
        private set => SetProperty(ref _isBusy, value);
    }

    public string? ErrorMessage
    {
        get => _errorMessage;
        private set => SetProperty(ref _errorMessage, value);
    }

    /// <summary>Non-error informational text — e.g. "Acuity isn't
    /// configured yet" (Configured=false is an expected state, not a
    /// fetch failure) — shown instead of the grid.</summary>
    public string? StatusMessage
    {
        get => _statusMessage;
        private set => SetProperty(ref _statusMessage, value);
    }

    public string? AsOf
    {
        get => _asOf;
        private set
        {
            if (SetProperty(ref _asOf, value))
            {
                OnPropertyChanged(nameof(AsOfDisplay));
            }
        }
    }

    /// <summary>Null (renders as empty text) until a load has actually
    /// completed — avoids showing a bare "As of" label before AsOf has a
    /// value.</summary>
    public string? AsOfDisplay => AsOf is null ? null : $"As of {AsOf}";

    public ICommand LoadCommand { get; }

    public async Task LoadAsync()
    {
        IsBusy = true;
        ErrorMessage = null;
        StatusMessage = null;
        try
        {
            var result = await _apiService.GetAppointmentScheduleAsync();

            if (!result.Configured)
            {
                Rows.Clear();
                VaccineNames.Clear();
                StatusMessage = result.Message ?? "Acuity scheduling isn't configured yet.";
                return;
            }

            if (result.Table is null)
            {
                Rows.Clear();
                VaccineNames.Clear();
                ErrorMessage = "The cloud app didn't return schedule data for this range.";
                return;
            }

            VaccineNames.Clear();
            foreach (var vaccineName in result.Table.Rows.Select(r => r.VaccineName))
            {
                VaccineNames.Add(vaccineName);
            }

            Rows.Clear();
            foreach (var row in AppointmentTablePivot.Pivot(result.Table))
            {
                Rows.Add(row);
            }
            Rows.Add(AppointmentTablePivot.BuildSummaryRow(result.Table));

            AsOf = result.AsOf;
        }
        catch (Exception ex)
        {
            ErrorMessage = $"Couldn't load the schedule: {ex.Message}";
        }
        finally
        {
            IsBusy = false;
        }
    }
}
