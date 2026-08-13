using System;
using System.Collections.ObjectModel;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Input;
using VaccineAssist.Desktop.Common;
using VaccineAssist.Desktop.Models;
using VaccineAssist.Desktop.Services;

namespace VaccineAssist.Desktop.ViewModels;

/// <summary>Backs the Lots screen (inventory + expirations) — lists lots
/// and lets staff add a new one when a shipment comes in.</summary>
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

    public ObservableCollection<Vaccine> Vaccines { get; } = new();
    public ObservableCollection<Lot> Lots { get; } = new();

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
            var lotsTask = _apiService.GetLotsAsync();
            await Task.WhenAll(vaccinesTask, lotsTask);

            Vaccines.Clear();
            foreach (var vaccine in vaccinesTask.Result.OrderBy(v => v.Name))
            {
                Vaccines.Add(vaccine);
            }

            Lots.Clear();
            foreach (var lot in lotsTask.Result.OrderBy(l => l.Expiration))
            {
                Lots.Add(lot);
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

            Lots.Add(created);
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
}
