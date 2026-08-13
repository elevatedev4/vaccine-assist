using System;
using System.Collections.ObjectModel;
using System.Threading.Tasks;
using System.Windows.Input;
using VaccineAssist.Desktop.Common;
using VaccineAssist.Desktop.Models;
using VaccineAssist.Desktop.Services;

namespace VaccineAssist.Desktop.ViewModels;

/// <summary>Backs the Vaccines screen ("what we offer") — a read-only
/// list of the active formulary, seeded from supabase/seed/vaccines.sql.</summary>
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

    public ObservableCollection<Vaccine> Vaccines { get; } = new();

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
            var vaccines = await _apiService.GetVaccinesAsync();
            Vaccines.Clear();
            foreach (var vaccine in vaccines)
            {
                Vaccines.Add(vaccine);
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
}
