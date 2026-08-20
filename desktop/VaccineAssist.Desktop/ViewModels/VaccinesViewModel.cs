using System;
using System.Collections.ObjectModel;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Input;
using VaccineAssist.Desktop.Common;
using VaccineAssist.Desktop.Services;

namespace VaccineAssist.Desktop.ViewModels;

/// <summary>Backs the Active vaccines tab — the admin view of the whole
/// formulary (active + inactive), with a read-only "has a current lot"
/// indicator and an editable, persisted Active toggle. Sorted active-first,
/// then alphabetically by name.</summary>
public sealed class VaccinesViewModel : ObservableObject
{
    private readonly IVaccineApiService _apiService;

    private bool _isBusy;
    private string? _errorMessage;

    public VaccinesViewModel(IVaccineApiService apiService)
    {
        _apiService = apiService;
        LoadCommand = new AsyncRelayCommand(LoadAsync, () => !IsBusy);
    }

    public ObservableCollection<VaccineRowViewModel> Vaccines { get; } = new();

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

    public ICommand LoadCommand { get; }

    public async Task LoadAsync()
    {
        IsBusy = true;
        ErrorMessage = null;
        try
        {
            var vaccines = await _apiService.GetAllVaccinesAsync();

            foreach (var existingRow in Vaccines)
            {
                existingRow.ActiveToggleRequested -= OnActiveToggleRequested;
            }
            Vaccines.Clear();

            foreach (var vaccine in vaccines.OrderByDescending(v => v.Active).ThenBy(v => v.Name, StringComparer.OrdinalIgnoreCase))
            {
                var row = new VaccineRowViewModel(vaccine);
                row.ActiveToggleRequested += OnActiveToggleRequested;
                Vaccines.Add(row);
            }
        }
        catch (Exception ex)
        {
            ErrorMessage = $"Couldn't load vaccines: {ex.Message}";
        }
        finally
        {
            IsBusy = false;
        }
    }

    /// <summary>Persists a checkbox toggle from the DataGrid's Active
    /// column. The row's Active property is already updated locally by
    /// the time this fires (see VaccineRowViewModel.Active's setter) — on
    /// failure this reverts it and surfaces the error, rather than
    /// leaving the UI showing a state that never actually made it to
    /// Supabase.</summary>
    private async void OnActiveToggleRequested(VaccineRowViewModel row, bool newActive)
    {
        var previousValue = !newActive;
        ErrorMessage = null;
        try
        {
            await _apiService.SetVaccineActiveAsync(row.Id, newActive);
        }
        catch (Exception ex)
        {
            ErrorMessage = $"Couldn't update {row.Name}: {ex.Message}";
            row.RevertActive(previousValue);
        }
    }
}
