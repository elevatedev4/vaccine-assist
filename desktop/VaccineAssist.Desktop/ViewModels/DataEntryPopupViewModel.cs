using System;
using System.Collections.ObjectModel;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Input;
using VaccineAssist.Desktop.Common;
using VaccineAssist.Desktop.Logging;
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
///
/// Will, 2026-08-19/20: "Remove Right Arm and Validate and Dry run... We
/// won't be using any of that right now." Right Arm and Dry run are
/// removed outright — AdminSite is always LeftArm now (no way to override
/// it from the UI; see AdminSite's own doc comment), and IsDryRun is
/// still computed from pioneerWindowDetected but is no longer a visible,
/// user-toggleable checkbox. The Validate BUTTON is removed, but the
/// eligibility check it triggered is still a real safety gate (blocks
/// "Enter into Pioneer" for an age-inappropriate vaccine — see
/// DataEntryGate) — removing that entirely felt like a bigger, riskier
/// change than "hide a button," so instead SelectedVaccine/PatientAgeYears's
/// setters now trigger it automatically the moment both are filled in
/// (see TryAutoValidate). Flagged in the report back to Will as a judgment
/// call worth confirming, not a literal reading of "remove Validate."
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
    private readonly AdminSite _adminSite = AdminSite.LeftArm;
    private readonly bool _isDryRun;
    private EligibilityResult? _eligibilityResult;

    /// <param name="pioneerWindowDetected">
    /// Whether the hotkey handler's light presence check (Uia/PioneerRxPresence)
    /// found a PioneerRx window before showing this popup — decides
    /// IsDryRun for the whole life of this popup instance (no point
    /// defaulting to a live run when nothing was found a moment ago).
    /// No longer a user-toggleable checkbox (Will, 2026-08-19/20: "Remove
    /// ... Dry run ... we won't be using any of that right now") — if
    /// PioneerRx isn't detected, the popup silently runs the sequence in
    /// dry-run/log-only mode rather than attempting a live entry against
    /// a window that isn't there.
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
            _statusMessage = "PioneerRx window not detected — entering data will run in dry-run/log-only mode. Open the patient's Rx profile first if you want a live entry.";
        }

        LoadCommand = new AsyncRelayCommand(LoadAsync, () => !IsBusy);
        ValidateCommand = new AsyncRelayCommand(ValidateAsync, () => !IsBusy && SelectedVaccine is not null && PatientAgeYears is not null);
        EnterIntoPioneerCommand = new AsyncRelayCommand(EnterIntoPioneerAsync, () => !IsBusy && Gate.CanEnterIntoPioneer);
        CopyToClipboardCommand = new AsyncRelayCommand(CopyToClipboardAsync, () => !IsBusy && SelectedVaccine is not null);
        CopyLogsCommand = new RelayCommand(CopyLogsToClipboard);
    }

    public ObservableCollection<Vaccine> Vaccines { get; } = new();
    public ObservableCollection<string> StepLog { get; } = new();

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
                TryAutoValidate();
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
                TryAutoValidate();
            }
        }
    }

    /// <summary>
    /// Always LeftArm — Will, 2026-08-19/20: "Remove Right Arm ... we
    /// won't be using any of that right now." No setter/UI anymore; a
    /// fresh DataEntryPopupViewModel is constructed every time the popup
    /// opens (see MainWindow.ShowDataEntryPopup), so this is guaranteed
    /// LeftArm every time.
    /// </summary>
    public AdminSite AdminSite => _adminSite;

    /// <summary>True = PioneerEntrySequenceRunner logs each step without touching PioneerRx. Fixed for the life of the popup from pioneerWindowDetected (see constructor) — no longer a user-toggleable checkbox (Will, 2026-08-19/20: "Remove ... Dry run ... we won't be using any of that right now").</summary>
    public bool IsDryRun => _isDryRun;

    /// <summary>
    /// Runs the eligibility check automatically once both a vaccine and an
    /// age are entered, replacing the removed "Validate" button (see class
    /// doc comment) — fire-and-forget is safe here because ValidateAsync
    /// already fully wraps its own body in try/catch and sets
    /// IsBusy/ErrorMessage itself, and AsyncRelayCommand.Execute (used via
    /// ValidateCommand) has its own catch-all backstop too. Re-entrancy
    /// (e.g. the user changes the age again while a check is in flight) is
    /// handled by ValidateCommand's existing CanExecute guard.
    /// </summary>
    private void TryAutoValidate()
    {
        if (ValidateCommand.CanExecute(null))
        {
            ValidateCommand.Execute(null);
        }
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

    /// <summary>
    /// Will, 2026-08-19/20: "make a way to copy those logs to send to
    /// you" — after a failed "Enter into Pioneer" ("FAILED - No PioneerRx
    /// window"). Copies the recent lines from %AppData%\VaccineAssist\
    /// logs\app.log (see AppFileLog) to the clipboard: crash records, plus
    /// every step this popup's own sequence runs log via context.Log,
    /// which now also writes to that same file (see EnterIntoPioneerAsync)
    /// so a failure is still copyable even after StepLog.Clear() wipes the
    /// on-screen list (e.g. the user picked a different vaccine before
    /// clicking Copy logs).
    /// </summary>
    public ICommand CopyLogsCommand { get; }

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

            var context = new PioneerEntryStepContext(payload, IsDryRun, message =>
            {
                StepLog.Add(message);
                // Also persisted to the file log (see AppFileLog) so "Copy
                // logs" can still grab this after StepLog.Clear() wipes
                // the on-screen list — see CopyLogsCommand's doc comment.
                AppFileLog.Log($"[DataEntry] {message}");
            });
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

    private void CopyLogsToClipboard()
    {
        try
        {
            var lines = AppFileLog.ReadRecentLines();
            if (string.IsNullOrEmpty(lines))
            {
                StatusMessage = "No logs recorded yet.";
                return;
            }

            _clipboardService.SetText(lines);
            StatusMessage = "Recent logs copied to clipboard.";
        }
        catch (Exception ex)
        {
            // The clipboard API can throw (another process holding it
            // open, common on Windows) — this button must never crash the
            // popup, just tell the user it didn't work this time.
            ErrorMessage = $"Couldn't copy logs: {ex.Message}";
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
