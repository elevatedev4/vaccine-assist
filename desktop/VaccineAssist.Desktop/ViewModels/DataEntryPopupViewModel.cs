using System;
using System.Collections.ObjectModel;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Input;
using VaccineAssist.Desktop.Common;
using VaccineAssist.Desktop.Models;
using VaccineAssist.Desktop.PioneerEntryAutomation;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing;
using VaccineAssist.Desktop.Services;

namespace VaccineAssist.Desktop.ViewModels;

/// <summary>
/// Backs the Ctrl+NumPad2 data-entry popup (V-T3, the headline feature —
/// "replacing my macro"). Unlike EntryViewModel (the existing Entry
/// screen: browse-and-copy, reachable from the main nav), this is the
/// hotkey-triggered quick-entry flow: vaccine + age only, validate, then
/// either run the PioneerEntrySequence or fall back to the same
/// clipboard payload the Entry screen already uses.
///
/// NO PHI: PatientAgeYears is held only on this object, for exactly as
/// long as the popup is open, and is never written to LocalSettingsService,
/// never sent anywhere except the (age-only, no identifiers) eligibility
/// check. Closing the popup (see DataEntryPopupWindow) drops this
/// instance entirely, discarding it.
/// </summary>
public sealed class DataEntryPopupViewModel : ObservableObject
{
    private readonly IVaccineApiService _apiService;
    private readonly IClipboardService _clipboardService;
    private readonly IPioneerEntrySequence _sequence;

    private bool _isBusy;
    private string? _errorMessage;
    private string? _statusMessage;
    private Vaccine? _selectedVaccine;
    private int? _patientAgeYears;
    private AdminSite _adminSite = AdminSite.LeftArm;
    private bool _isDryRun;
    private EligibilityResult? _eligibilityResult;

    /// <param name="pioneerWindowDetected">
    /// Whether the hotkey handler's light presence check (Uia/PioneerRxPresence)
    /// found a PioneerRx window before showing this popup — seeds IsDryRun's
    /// default (no point defaulting to a live run when nothing was found a
    /// moment ago), but stays a visible, user-toggleable checkbox rather than
    /// a hidden decision, since PioneerRx's foreground window can change
    /// between the hotkey press and clicking "Enter into Pioneer".
    /// </param>
    public DataEntryPopupViewModel(
        IVaccineApiService apiService,
        IClipboardService clipboardService,
        IPioneerEntrySequence sequence,
        bool pioneerWindowDetected)
    {
        _apiService = apiService;
        _clipboardService = clipboardService;
        _sequence = sequence;
        _isDryRun = !pioneerWindowDetected;
        if (!pioneerWindowDetected)
        {
            _statusMessage = "PioneerRx window not detected — Dry run is on by default. Open the patient's Rx profile, then uncheck Dry run once ready to enter data for real.";
        }

        LoadCommand = new AsyncRelayCommand(LoadAsync, () => !IsBusy);
        ValidateCommand = new AsyncRelayCommand(ValidateAsync, () => !IsBusy && SelectedVaccine is not null && PatientAgeYears is not null);
        EnterIntoPioneerCommand = new AsyncRelayCommand(EnterIntoPioneerAsync, () => !IsBusy && Gate.CanEnterIntoPioneer);
        CopyToClipboardCommand = new AsyncRelayCommand(CopyToClipboardAsync, () => !IsBusy && SelectedVaccine is not null);
    }

    public ObservableCollection<Vaccine> Vaccines { get; } = new();
    public ObservableCollection<string> StepLog { get; } = new();
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

    public string? StatusMessage
    {
        get => _statusMessage;
        private set => SetProperty(ref _statusMessage, value);
    }

    public Vaccine? SelectedVaccine
    {
        get => _selectedVaccine;
        set
        {
            if (SetProperty(ref _selectedVaccine, value))
            {
                EligibilityResult = null;
                StepLog.Clear();
            }
        }
    }

    /// <summary>Typed by the user each time; never persisted (see class doc).</summary>
    public int? PatientAgeYears
    {
        get => _patientAgeYears;
        set
        {
            if (SetProperty(ref _patientAgeYears, value))
            {
                EligibilityResult = null;
            }
        }
    }

    public AdminSite AdminSite
    {
        get => _adminSite;
        set => SetProperty(ref _adminSite, value);
    }

    /// <summary>
    /// Compact popup control for the (rare) Right-arm override (Will,
    /// 2026-08-19: "Hide Admin site ... always default it to Left Arm ...
    /// keep a way to switch to Right if trivial"). AdminSite already
    /// defaults to LeftArm via the field initializer above, and a fresh
    /// DataEntryPopupViewModel is constructed every time the popup opens
    /// (see MainWindow.ShowDataEntryPopup), so this is guaranteed to start
    /// unchecked/Left every time, never carrying a Right selection over
    /// from a prior popup. Backs a small CheckBox instead of the old full
    /// ComboBox — see DataEntryPopupWindow.xaml.
    /// </summary>
    public bool IsRightArm
    {
        get => AdminSite == AdminSite.RightArm;
        set => AdminSite = value ? AdminSite.RightArm : AdminSite.LeftArm;
    }

    /// <summary>True = PioneerEntrySequenceRunner logs each step without touching PioneerRx. Defaults from pioneerWindowDetected; user-toggleable.</summary>
    public bool IsDryRun
    {
        get => _isDryRun;
        set => SetProperty(ref _isDryRun, value);
    }

    public EligibilityResult? EligibilityResult
    {
        get => _eligibilityResult;
        private set
        {
            if (SetProperty(ref _eligibilityResult, value))
            {
                OnPropertyChanged(nameof(Gate));
            }
        }
    }

    /// <summary>Pure gate decision (DataEntryGate) — bound directly for the popup's inline block message and "Enter into Pioneer" enablement.</summary>
    public DataEntryGate.Decision Gate => DataEntryGate.Evaluate(EligibilityResult);

    public ICommand LoadCommand { get; }
    public ICommand ValidateCommand { get; }
    public ICommand EnterIntoPioneerCommand { get; }
    public ICommand CopyToClipboardCommand { get; }

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

    private async Task ValidateAsync()
    {
        if (SelectedVaccine is null || PatientAgeYears is not int age) return;

        IsBusy = true;
        ErrorMessage = null;
        try
        {
            EligibilityResult = await _apiService.EvaluateEligibilityAsync(SelectedVaccine.Id, age, isPregnant: null);
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

    private async Task EnterIntoPioneerAsync()
    {
        if (!Gate.CanEnterIntoPioneer || SelectedVaccine is null) return;

        IsBusy = true;
        ErrorMessage = null;
        StepLog.Clear();
        try
        {
            var payload = await BuildPayloadAsync();
            if (payload is null) return; // BuildPayloadAsync already set ErrorMessage

            var context = new PioneerEntryStepContext(payload, IsDryRun, message => StepLog.Add(message));
            var result = await PioneerEntrySequenceRunner.RunAsync(_sequence, context);

            StatusMessage = result.Success
                ? (IsDryRun ? "Dry run complete — no PioneerRx changes made." : "Entered into PioneerRx.")
                : $"Stopped at \"{result.FirstFailure?.StepName}\" — see step log below.";
        }
        catch (Exception ex)
        {
            ErrorMessage = $"Couldn't run the entry sequence: {ex.Message}";
        }
        finally
        {
            IsBusy = false;
        }
    }

    private async Task CopyToClipboardAsync()
    {
        if (SelectedVaccine is null) return;

        IsBusy = true;
        ErrorMessage = null;
        try
        {
            var payload = await BuildPayloadAsync();
            if (payload is null) return;

            _clipboardService.SetText(payload.ToClipboardPayload());
            StatusMessage = "Copied to clipboard — paste into PioneerRx.";
        }
        catch (Exception ex)
        {
            ErrorMessage = $"Couldn't build the entry payload: {ex.Message}";
        }
        finally
        {
            IsBusy = false;
        }
    }

    /// <summary>
    /// Resolves the active lot to use (FEFO — earliest expiration first,
    /// the standard inventory-rotation rule) and builds the payload.
    /// Returns null (with ErrorMessage set) if no active lot is on file —
    /// the popup deliberately does NOT ask staff to pick a lot manually
    /// (out of scope per V-T3's field list: vaccine + age only), so a
    /// missing lot is a hard stop with a clear next action instead.
    /// </summary>
    private async Task<VaccineEntryPayload?> BuildPayloadAsync()
    {
        if (SelectedVaccine is null)
        {
            ErrorMessage = "Select a vaccine first.";
            return null;
        }

        var activeLots = await _apiService.GetLotsAsync(SelectedVaccine.Id, status: "active");
        var lot = activeLots.OrderBy(l => l.Expiration).FirstOrDefault();
        if (lot is null)
        {
            ErrorMessage = $"No active lot on file for {SelectedVaccine.Name} — add one on the Lots screen first.";
            return null;
        }

        return new VaccineEntryPayload(SelectedVaccine.ShortCode, lot.LotNumber, lot.ExpirationMacroFormat, AdminSite.ToDisplayText());
    }
}
