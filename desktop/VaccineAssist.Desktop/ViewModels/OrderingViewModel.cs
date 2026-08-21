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
/// Backs the Ordering tab: pulls per-vaccine reorder recommendations from
/// GET /api/ordering/recommendation (via
/// IVaccineApiService.GetOrderingRecommendationAsync) — upcoming 7-day
/// scheduled appointments, current on-hand stock (from the daily on-hand
/// email once that's wired up on Will's end), and a walk-in buffer; see
/// cloud/lib/ordering-recommendation.ts for the exact math. Same
/// loading/error pattern as SchedulingViewModel: this is a network call,
/// so it always has a busy/error state, and it never crashes or shows a
/// MessageBox — failures surface via ErrorMessage only.
/// </summary>
public sealed class OrderingViewModel : ObservableObject
{
    private readonly IVaccineApiService _apiService;

    private bool _isBusy;
    private string? _errorMessage;
    private string? _onHandStatusMessage;

    public OrderingViewModel(IVaccineApiService apiService)
    {
        _apiService = apiService;
        LoadCommand = new AsyncRelayCommand(LoadAsync, () => !IsBusy);
    }

    /// <summary>Rows sorted by RecommendedOrder descending, then
    /// VaccineName ascending — done here in the ViewModel rather than
    /// relied on from the API's own row order.</summary>
    public ObservableCollection<OrderingRecommendationRow> Rows { get; } = new();

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

    /// <summary>Always populated after a successful load: either a
    /// readable "On-hand data last received: ..." note, or — when
    /// OnHandLastReceivedAt is null (no on-hand email has ever been
    /// ingested) — a message explaining the expected email format, shown
    /// above the table instead of leaving staff looking at an
    /// unexplained empty-looking On hand column.</summary>
    public string? OnHandStatusMessage
    {
        get => _onHandStatusMessage;
        private set => SetProperty(ref _onHandStatusMessage, value);
    }

    public ICommand LoadCommand { get; }

    public async Task LoadAsync()
    {
        IsBusy = true;
        ErrorMessage = null;
        try
        {
            var result = await _apiService.GetOrderingRecommendationAsync();

            Rows.Clear();
            foreach (var row in result.Rows
                         .OrderByDescending(r => r.RecommendedOrder)
                         .ThenBy(r => r.VaccineName, StringComparer.OrdinalIgnoreCase))
            {
                Rows.Add(row);
            }

            OnHandStatusMessage = result.OnHandLastReceivedAt is DateTimeOffset asOf
                ? $"On-hand data last received: {asOf.LocalDateTime:MMM d, yyyy h:mm tt}"
                : "No on-hand data received yet — email format: one line per vaccine, "
                  + "\"VaccineName, Quantity\" (see cloud/lib/on-hand-parser.ts for the full spec).";
        }
        catch (Exception ex)
        {
            ErrorMessage = $"Couldn't load ordering recommendations: {ex.Message}";
        }
        finally
        {
            IsBusy = false;
        }
    }
}
