using System;
using System.Collections.ObjectModel;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Input;
using VaccineAssist.Desktop.Common;
using VaccineAssist.Desktop.Models;
using VaccineAssist.Desktop.Services;

namespace VaccineAssist.Desktop.ViewModels;

/// <summary>Backs the Lots screen (inventory + expirations) — MSG893 item
/// 4 turned this into an editable, autosaving table (vaccine name/NDC
/// joined in, lot number/expiration/beyond-use date/note inline-editable)
/// — plus lets staff add a new lot when a shipment comes in (unchanged).</summary>
public sealed class LotsViewModel : ObservableObject
{
    private readonly IVaccineApiService _apiService;

    private bool _isBusy;
    private string? _errorMessage;
    private Vaccine? _newLotVaccine;
    private string _newLotNumber = "";
    private DateTime _newLotExpiration = DateTime.Today.AddYears(1);
    private string? _newLotNote;

    public LotsViewModel(IVaccineApiService apiService)
    {
        _apiService = apiService;
        LoadCommand = new AsyncRelayCommand(LoadAsync, () => !IsBusy);
        AddLotCommand = new AsyncRelayCommand(AddLotAsync, () => !IsBusy && NewLotVaccine is not null && !string.IsNullOrWhiteSpace(NewLotNumber));
    }

    /// <summary>ACTIVE vaccines only — backs the "Add a lot" form's
    /// vaccine picker, unchanged from before MSG893 item 4.</summary>
    public ObservableCollection<Vaccine> Vaccines { get; } = new();

    public ObservableCollection<LotRowViewModel> Lots { get; } = new();

    /// <summary>V-T21 item 4 (Will, 2026-09-08): the same LotRowViewModel
    /// instances as Lots, partitioned by LotRowViewModel.IsVaccineActive —
    /// ActiveLots/InactiveLots are what Views/LotsView.xaml actually binds
    /// its two DataGrids to (active on top, inactive in a collapsed
    /// "Inactive vaccines (N)" Expander below), while Lots itself stays
    /// the full flat list for callers/tests that don't care about the
    /// split. Rebuilt every LoadAsync/AddLotAsync alongside Lots — never
    /// diverges from it.</summary>
    public ObservableCollection<LotRowViewModel> ActiveLots { get; } = new();

    public ObservableCollection<LotRowViewModel> InactiveLots { get; } = new();

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

    public Vaccine? NewLotVaccine
    {
        get => _newLotVaccine;
        set => SetProperty(ref _newLotVaccine, value);
    }

    public string NewLotNumber
    {
        get => _newLotNumber;
        set => SetProperty(ref _newLotNumber, value);
    }

    public DateTime NewLotExpiration
    {
        get => _newLotExpiration;
        set => SetProperty(ref _newLotExpiration, value);
    }

    public string? NewLotNote
    {
        get => _newLotNote;
        set => SetProperty(ref _newLotNote, value);
    }

    public ICommand LoadCommand { get; }
    public ICommand AddLotCommand { get; }

    public async Task LoadAsync()
    {
        IsBusy = true;
        ErrorMessage = null;
        try
        {
            var vaccinesTask = _apiService.GetVaccinesAsync();
            // ALL vaccines (active + inactive), not just Vaccines above —
            // MSG893 item 4's vaccine name/NDC join must still resolve for
            // a lot attached to a since-deactivated (or orphan-duplicate,
            // see DataEntryPopupViewModel.FindActiveLotForVaccineAsync's
            // doc comment) vaccine row, not only active ones.
            var allVaccinesTask = _apiService.GetAllVaccinesAsync();
            var lotsTask = _apiService.GetLotsAsync();
            await Task.WhenAll(vaccinesTask, allVaccinesTask, lotsTask);

            Vaccines.Clear();
            foreach (var vaccine in vaccinesTask.Result.OrderBy(v => v.Name, StringComparer.OrdinalIgnoreCase))
            {
                Vaccines.Add(vaccine);
            }

            var vaccinesById = allVaccinesTask.Result.ToDictionary(v => v.Id);

            foreach (var existingRow in Lots)
            {
                existingRow.EditCommitted -= OnRowEditCommitted;
            }
            Lots.Clear();
            ActiveLots.Clear();
            InactiveLots.Clear();
            foreach (var lot in lotsTask.Result.OrderBy(l => l.Expiration))
            {
                vaccinesById.TryGetValue(lot.VaccineId, out var vaccine);
                // An orphan lot with no matching vaccine row at all
                // (LoadFallsBackToAPlaceholderNameWhenNoVaccineRowMatchesAtAll)
                // is treated as active — there's no active flag to read, and
                // hiding it in the collapsed section would make an already
                // rare/unexpected orphan even easier to miss.
                var row = new LotRowViewModel(lot, vaccine?.Name ?? "(unknown vaccine)", vaccine?.Ndc, vaccine?.Active ?? true);
                row.EditCommitted += OnRowEditCommitted;
                Lots.Add(row);
                (row.IsVaccineActive ? ActiveLots : InactiveLots).Add(row);
            }
        }
        catch (Exception ex)
        {
            ErrorMessage = $"Couldn't load lots: {ex.Message}";
        }
        finally
        {
            IsBusy = false;
        }
    }

    private async Task AddLotAsync()
    {
        if (NewLotVaccine is null || string.IsNullOrWhiteSpace(NewLotNumber)) return;

        IsBusy = true;
        ErrorMessage = null;
        try
        {
            var expiration = DateOnly.FromDateTime(NewLotExpiration);
            var created = await _apiService.CreateLotAsync(
                NewLotVaccine.Id, NewLotNumber.Trim(), expiration, note: NewLotNote);

            // NewLotVaccine is only ever chosen from Vaccines (active-only —
            // see that property's own doc comment), so this new row is
            // always active.
            var row = new LotRowViewModel(created, NewLotVaccine.Name, NewLotVaccine.Ndc, isVaccineActive: true);
            row.EditCommitted += OnRowEditCommitted;
            Lots.Add(row);
            ActiveLots.Add(row);
            NewLotNumber = "";
            NewLotNote = null;
        }
        catch (Exception ex)
        {
            ErrorMessage = $"Couldn't add lot: {ex.Message}";
        }
        finally
        {
            IsBusy = false;
        }
    }

    /// <summary>
    /// MSG893 item 4 ("AUTOSAVE"): fired by a LotRowViewModel every time
    /// one of its editable fields commits (DataGrid cell-edit-end). Sends
    /// the row's CURRENT full snapshot (not a partial diff — see
    /// IVaccineApiService.UpdateLotAsync's own doc comment) via PATCH, and
    /// reports the outcome back to the row itself: ApplySaveSuccess marks
    /// these values as the new revert point, ApplySaveFailure reverts the
    /// row and surfaces the error inline (row.SaveError — see
    /// Views/LotsView.xaml's status column) rather than failing silently.
    /// Both are no-ops if `token` has since been superseded by a newer
    /// edit to the same row (see LotRowViewModel's own doc comment for why
    /// that's the correct behavior, not a bug).
    /// </summary>
    private async void OnRowEditCommitted(LotRowViewModel row, int token)
    {
        var snapshot = row.CurrentSnapshot();
        try
        {
            var beyondUseDate = snapshot.BeyondUseDate is DateTime bud ? DateOnly.FromDateTime(bud) : (DateOnly?)null;
            await _apiService.UpdateLotAsync(
                row.Id,
                snapshot.LotNumber.Trim(),
                DateOnly.FromDateTime(snapshot.Expiration),
                beyondUseDate,
                snapshot.Note);
            row.ApplySaveSuccess(token);
        }
        catch (Exception ex)
        {
            row.ApplySaveFailure(token, $"Couldn't save: {ex.Message}");
        }
    }
}
