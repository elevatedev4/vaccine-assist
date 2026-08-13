using System;
using System.Collections.ObjectModel;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Input;
using VaccineAssist.Desktop.Common;
using VaccineAssist.Desktop.Models;
using VaccineAssist.Desktop.PioneerEntryAutomation;
using VaccineAssist.Desktop.Services;

namespace VaccineAssist.Desktop.ViewModels;

/// <summary>
/// Backs the Entry screen (quick-entry) — replaces vaccine-add-new.mxe.
/// Phase 1 scope per the brief: selecting a vaccine + lot generates the
/// `code,lot,exp` payload, shown on screen and copied to the clipboard.
/// Eligibility is checked and surfaced as a warning/block, same as the
/// old macro's age/pregnancy gates, but nothing here drives PioneerRx
/// directly yet (see PioneerEntryAutomation/TODO.md).
/// </summary>
public sealed class EntryViewModel : ObservableObject
{
    private readonly IVaccineApiService _apiService;
    private readonly IClipboardService _clipboardService;
    private readonly IPioneerEntryAutomation _pioneerEntryAutomation;

    private bool _isBusy;
    private string? _errorMessage;
    private Vaccine? _selectedVaccine;
    private Lot? _selectedLot;
    private AdminSite _adminSite = AdminSite.LeftArm;
    private int? _patientAgeYears;
    private bool? _isPregnant;
    private EligibilityResult? _eligibilityResult;
    private string? _generatedPayload;
    private string? _statusMessage;

    public EntryViewModel(
        IVaccineApiService apiService,
        IClipboardService clipboardService,
        IPioneerEntryAutomation pioneerEntryAutomation)
    {
        _apiService = apiService;
        _clipboardService = clipboardService;
        _pioneerEntryAutomation = pioneerEntryAutomation;

        LoadCommand = new AsyncRelayCommand(LoadAsync, () => !IsBusy);
        CheckEligibilityCommand = new AsyncRelayCommand(CheckEligibilityAsync, () => !IsBusy && SelectedVaccine is not null && PatientAgeYears is not null);
        GenerateAndCopyCommand = new RelayCommand(GenerateAndCopy, () => SelectedVaccine is not null && SelectedLot is not null);
    }

    public ObservableCollection<Vaccine> Vaccines { get; } = new();
    public ObservableCollection<Lot> AvailableLots { get; } = new();
    public AdminSite[] AdminSiteOptions { get; } = { AdminSite.LeftArm, AdminSite.RightArm };

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

    public Vaccine? SelectedVaccine
    {
        get => _selectedVaccine;
        set
        {
            if (SetProperty(ref _selectedVaccine, value))
            {
                EligibilityResult = null;
                _ = RefreshLotsForSelectedVaccineAsync();
            }
        }
    }

    public Lot? SelectedLot
    {
        get => _selectedLot;
        set => SetProperty(ref _selectedLot, value);
    }

    public AdminSite AdminSite
    {
        get => _adminSite;
        set => SetProperty(ref _adminSite, value);
    }

    public int? PatientAgeYears
    {
        get => _patientAgeYears;
        set => SetProperty(ref _patientAgeYears, value);
    }

    /// <summary>Null = unknown/not asked yet, matching cloud/lib/eligibility.ts's
    /// "unknown pregnancy status is a warning, not a block" behavior.</summary>
    public bool? IsPregnant
    {
        get => _isPregnant;
        set => SetProperty(ref _isPregnant, value);
    }

    public EligibilityResult? EligibilityResult
    {
        get => _eligibilityResult;
        private set => SetProperty(ref _eligibilityResult, value);
    }

    public string? GeneratedPayload
    {
        get => _generatedPayload;
        private set => SetProperty(ref _generatedPayload, value);
    }

    public string? StatusMessage
    {
        get => _statusMessage;
        private set => SetProperty(ref _statusMessage, value);
    }

    public ICommand LoadCommand { get; }
    public ICommand CheckEligibilityCommand { get; }
    public ICommand GenerateAndCopyCommand { get; }

    public async Task LoadAsync()
    {
        IsBusy = true;
        ErrorMessage = null;
        try
        {
            var vaccines = await _apiService.GetVaccinesAsync();
            Vaccines.Clear();
            foreach (var vaccine in vaccines.OrderBy(v => v.Name))
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

    private async Task RefreshLotsForSelectedVaccineAsync()
    {
        AvailableLots.Clear();
        SelectedLot = null;
        if (SelectedVaccine is null) return;

        try
        {
            var lots = await _apiService.GetLotsAsync(SelectedVaccine.Id, status: "active");
            foreach (var lot in lots.OrderBy(l => l.Expiration))
            {
                AvailableLots.Add(lot);
            }
        }
        catch (Exception ex)
        {
            ErrorMessage = $"Couldn't load lots for {SelectedVaccine.Name}: {ex.Message}";
        }
    }

    private async Task CheckEligibilityAsync()
    {
        if (SelectedVaccine is null || PatientAgeYears is not int age) return;

        IsBusy = true;
        ErrorMessage = null;
        try
        {
            EligibilityResult = await _apiService.EvaluateEligibilityAsync(SelectedVaccine.Id, age, IsPregnant);
        }
        catch (Exception ex)
        {
            ErrorMessage = $"Couldn't check eligibility: {ex.Message}";
        }
        finally
        {
            IsBusy = false;
        }
    }

    /// <summary>Builds the code,lot,exp payload (same shape as the old
    /// macro's clipboard input) and copies it. Never blocks on
    /// eligibility — same as the macro, an eligibility "blocked" result is
    /// a strong warning for staff judgment, not a hard stop enforced here.</summary>
    private void GenerateAndCopy()
    {
        if (SelectedVaccine is null || SelectedLot is null) return;

        var payload = new VaccineEntryPayload(
            SelectedVaccine.ShortCode,
            SelectedLot.LotNumber,
            SelectedLot.ExpirationMacroFormat,
            AdminSite.ToDisplayText());

        GeneratedPayload = payload.ToClipboardPayload();
        _clipboardService.SetText(GeneratedPayload);
        StatusMessage = _pioneerEntryAutomation.IsAttached
            ? "Copied to clipboard. (Live PioneerRx entry is not wired up yet — see PioneerEntryAutomation/TODO.md.)"
            : "Copied to clipboard — paste into PioneerRx.";
    }
}
