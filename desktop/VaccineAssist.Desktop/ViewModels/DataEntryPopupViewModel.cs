using System;
using System.Collections.Generic;
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
using VaccineAssist.Desktop.Uia;

namespace VaccineAssist.Desktop.ViewModels;

/// <summary>
/// Backs the Ctrl+NumPad2 data-entry popup (V-T3, the headline feature —
/// "replacing my macro"). Unlike EntryViewModel (the existing Entry
/// screen: browse-and-copy, reachable from the main nav), this is the
/// hotkey-triggered quick-entry flow.
///
/// GUIDED FLOW rework: one question at a time, all radio buttons —
/// age -> vaccine GROUP (common name, e.g. "COVID"/"Flu"/"Shingles" — see
/// Models/VaccineGroupCatalog) -> PRODUCT within that group (e.g. under
/// COVID: "Comirnaty 2025-26 12+", "mNEXSPIKE" — see
/// Models/VaccineProductOption) -> DOSE NUMBER, only asked when the chosen
/// product has more than one dose row on file -> review/enter. See
/// <see cref="CurrentStage"/> and ContinueFromAgeAsync/SelectGroup/
/// SelectProduct/SelectDose/GoBack for the state machine; Views/
/// DataEntryPopupWindow.xaml shows/hides each stage's panel off the
/// Is*Stage booleans below.
///
/// NO PHI: PatientAgeYears is held only on this object, for exactly as
/// long as the popup is open, and is never written to LocalSettingsService,
/// never sent anywhere except the (age-only, no identifiers) eligibility
/// checks. Closing the popup (see DataEntryPopupWindow) drops this
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
    /// <summary>The guided flow's question order. See CurrentStage.</summary>
    public enum Stage
    {
        Age,
        Group,
        Product,
        Dose,
        Review,
    }

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
    private Stage _currentStage = Stage.Age;
    private string? _selectedGroup;
    private VaccineProductOption? _selectedProduct;
    private Lot? _selectedVaccineActiveLot;
    private bool _skipLotAndExpiration;
    private string _newLotNumber = "";
    private DateTime _newLotExpiration = DateTime.Today.AddYears(1);
    private string? _newLotNote;

    /// <summary>Every active vaccine eligible for the age entered on the Age
    /// step (GetEligibleVaccinesForAgeAsync's result) — the pool SelectGroup/
    /// SelectProduct filter down from. Reset every time ContinueFromAgeAsync
    /// runs or the user backs all the way out to the Age step.</summary>
    private Vaccine[] _eligibleVaccinesForAge = Array.Empty<Vaccine>();

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

        ContinueFromAgeCommand = new AsyncRelayCommand(ContinueFromAgeAsync, () => !IsBusy && PatientAgeYears is not null);
        BackCommand = new RelayCommand(GoBack, () => !IsBusy && CurrentStage != Stage.Age);
        ValidateCommand = new AsyncRelayCommand(ValidateAsync, () => !IsBusy && SelectedVaccine is not null && PatientAgeYears is not null);
        EnterIntoPioneerCommand = new AsyncRelayCommand(EnterIntoPioneerAsync, () => !IsBusy && Gate.CanEnterIntoPioneer && (!IsLotExpiredOrMissing || SkipLotAndExpiration));
        CopyToClipboardCommand = new AsyncRelayCommand(CopyToClipboardAsync, () => !IsBusy && SelectedVaccine is not null);
        CopyLogsCommand = new RelayCommand(CopyLogsToClipboard);
        DumpUiaTreeCommand = new AsyncRelayCommand(DumpUiaTreeAsync, () => !IsBusy);
        AddLotCommand = new AsyncRelayCommand(AddLotAsync, () => !IsBusy && SelectedVaccine is not null && !string.IsNullOrWhiteSpace(NewLotNumber));
        SkipLotAndExpirationCommand = new RelayCommand(() => SkipLotAndExpiration = true, () => IsLotExpiredOrMissing);
    }

    public ObservableCollection<string> AvailableGroups { get; } = new();
    public ObservableCollection<VaccineProductOption> ProductOptions { get; } = new();
    public ObservableCollection<Vaccine> DoseOptions { get; } = new();
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

    /// <summary>Drives which of DataEntryPopupWindow.xaml's stage panels is
    /// visible — see the Is*Stage booleans below.</summary>
    public Stage CurrentStage
    {
        get => _currentStage;
        private set
        {
            if (_currentStage == value) return;
            _currentStage = value;
            OnPropertyChanged(nameof(IsAgeStage));
            OnPropertyChanged(nameof(IsGroupStage));
            OnPropertyChanged(nameof(IsProductStage));
            OnPropertyChanged(nameof(IsDoseStage));
            OnPropertyChanged(nameof(IsReviewStage));
        }
    }

    public bool IsAgeStage => CurrentStage == Stage.Age;
    public bool IsGroupStage => CurrentStage == Stage.Group;
    public bool IsProductStage => CurrentStage == Stage.Product;
    public bool IsDoseStage => CurrentStage == Stage.Dose;
    public bool IsReviewStage => CurrentStage == Stage.Review;

    public string? SelectedGroup
    {
        get => _selectedGroup;
        private set => SetProperty(ref _selectedGroup, value);
    }

    public VaccineProductOption? SelectedProduct
    {
        get => _selectedProduct;
        private set => SetProperty(ref _selectedProduct, value);
    }

    /// <summary>Public setter kept for test-harness compatibility
    /// (VaccineAssist.Desktop.Tests\DataEntryPopupViewModelAutoValidateTests.cs
    /// sets this directly to simulate a selection) even though the guided
    /// flow only ever sets it internally now, via SelectProduct/SelectDose/
    /// GoBack — the old flat all-vaccines RadioButton list that used to set
    /// this straight from DataEntryPopupWindow.xaml.cs's Checked handler is
    /// gone (replaced by the group -> product -> dose steps below).</summary>
    public Vaccine? SelectedVaccine
    {
        get => _selectedVaccine;
        set
        {
            if (SetProperty(ref _selectedVaccine, value))
            {
                EligibilityResult = null;
                StepLog.Clear();
                SkipLotAndExpiration = false;
                NewLotNumber = "";
                NewLotNote = null;
                SelectedVaccineActiveLot = null;
                OnPropertyChanged(nameof(IsLotExpiredOrMissing));
                TryAutoValidate();
                _ = RefreshSelectedVaccineActiveLotAsync();
            }
        }
    }

    /// <summary>Typed by the user each time; never persisted (see class doc).
    /// Still triggers TryAutoValidate on change (kept from before the
    /// guided-flow rework — see DataEntryPopupViewModelAutoValidateTests.cs)
    /// even though the guided flow itself only ever has a vaccine selected
    /// once age is already locked in via ContinueFromAgeAsync — this covers
    /// the case of a re-entrant/direct age change after a vaccine is
    /// already selected too.</summary>
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

    /// <summary>
    /// V-... Part C (expiration gate): the earliest-expiration ACTIVE lot
    /// on file for SelectedVaccine, refreshed by RefreshSelectedVaccineActiveLotAsync
    /// every time SelectedVaccine changes (and again after AddLotAsync
    /// succeeds). Null means either no vaccine is selected yet, or none is
    /// on file at all — see IsLotExpiredOrMissing, which treats both "no
    /// lot" and "an expired lot" the same way (both need staff to either
    /// add a fresh one or explicitly choose to skip it).
    /// </summary>
    public Lot? SelectedVaccineActiveLot
    {
        get => _selectedVaccineActiveLot;
        private set
        {
            if (SetProperty(ref _selectedVaccineActiveLot, value))
            {
                OnPropertyChanged(nameof(IsLotExpiredOrMissing));
            }
        }
    }

    /// <summary>True when a vaccine is selected and either no active lot is
    /// on file for it, or the earliest one on file is already expired —
    /// the popup's expiration gate (Views/DataEntryPopupWindow.xaml) shows
    /// the "add a lot" mini-form plus "leave blank and proceed" affordance
    /// whenever this is true, and EnterIntoPioneerCommand is blocked unless
    /// SkipLotAndExpiration is also true.</summary>
    public bool IsLotExpiredOrMissing =>
        SelectedVaccine is not null && (SelectedVaccineActiveLot is null || SelectedVaccineActiveLot.IsExpired);

    /// <summary>Set by SkipLotAndExpirationCommand — see VaccineEntryPayload.SkipLotAndExpiration's
    /// doc comment for how this reaches the Pioneer entry sequence. Reset to
    /// false every time SelectedVaccine changes (a fresh product/dose
    /// selection must not silently inherit a previous one's "proceed
    /// without a lot" choice).</summary>
    public bool SkipLotAndExpiration
    {
        get => _skipLotAndExpiration;
        private set => SetProperty(ref _skipLotAndExpiration, value);
    }

    /// <summary>Inline "add a lot" mini-form (Views/DataEntryPopupWindow.xaml's
    /// expiration-gate block) — same required fields LotsViewModel's own
    /// add-a-lot form uses, scoped here to the currently selected vaccine
    /// rather than a picker, so this doesn't need to reuse LotsView's full
    /// list-plus-refresh UI just to add one lot from inside a small popup.</summary>
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

    public ICommand ContinueFromAgeCommand { get; }
    public ICommand BackCommand { get; }
    public ICommand ValidateCommand { get; }
    public ICommand EnterIntoPioneerCommand { get; }
    public ICommand CopyToClipboardCommand { get; }
    public ICommand AddLotCommand { get; }
    public ICommand SkipLotAndExpirationCommand { get; }

    /// <summary>V-... Part A: dumps the attached PioneerRx window's full UIA
    /// tree to %AppData%\VaccineAssist\uia-dumps\ — see Uia/UiaTreeDumper.cs.</summary>
    public ICommand DumpUiaTreeCommand { get; }

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

    private async Task ContinueFromAgeAsync()
    {
        if (PatientAgeYears is not int age || age < 0 || age > 120)
        {
            ErrorMessage = "Enter a valid patient age first.";
            return;
        }

        IsBusy = true;
        ErrorMessage = null;
        try
        {
            var eligible = await _apiService.GetEligibleVaccinesForAgeAsync(age);
            _eligibleVaccinesForAge = eligible.ToArray();

            var groupsPresent = _eligibleVaccinesForAge.Select(VaccineGroupCatalog.GetGroup).ToHashSet();
            AvailableGroups.Clear();
            foreach (var group in VaccineGroupCatalog.DisplayOrder.Where(groupsPresent.Contains))
            {
                AvailableGroups.Add(group);
            }

            if (AvailableGroups.Count == 0)
            {
                ErrorMessage = $"No active vaccine on file is eligible for age {age}.";
                return;
            }

            CurrentStage = Stage.Group;
        }
        catch (Exception ex)
        {
            ErrorMessage = $"Couldn't check eligible vaccines: {ex.Message}";
        }
        finally
        {
            IsBusy = false;
        }
    }

    /// <summary>Called from DataEntryPopupWindow.xaml.cs's group RadioButton
    /// Checked handler (GroupRadioList_OnChecked) — see that method's doc
    /// comment for why this is plain code-behind rather than a binding
    /// (WPF has no built-in "SelectedItem" concept for a group of
    /// individually templated RadioButtons).</summary>
    public void SelectGroup(string group)
    {
        SelectedGroup = group;

        ProductOptions.Clear();
        var inGroup = _eligibleVaccinesForAge.Where(v => VaccineGroupCatalog.GetGroup(v) == group);
        foreach (var name in inGroup.Select(v => v.Name).Distinct())
        {
            var doseRows = OrderByDose(inGroup.Where(v => v.Name == name));
            ProductOptions.Add(new VaccineProductOption(name, doseRows));
        }

        CurrentStage = Stage.Product;
    }

    public void SelectProduct(VaccineProductOption product)
    {
        SelectedProduct = product;

        if (product.IsMultiDose)
        {
            DoseOptions.Clear();
            foreach (var doseRow in product.DoseRows)
            {
                DoseOptions.Add(doseRow);
            }
            CurrentStage = Stage.Dose;
        }
        else
        {
            SelectedVaccine = product.DoseRows[0];
            CurrentStage = Stage.Review;
        }
    }

    public void SelectDose(Vaccine doseVaccine)
    {
        SelectedVaccine = doseVaccine;
        CurrentStage = Stage.Review;
    }

    /// <summary>Orders a product's dose rows by their `dose` string parsed
    /// as an integer (e.g. Gardasil's "1"/"2"/"3") so the dose step lists
    /// them 1, 2, 3 — falls back to catalog order for anything unparsable
    /// (stable: ties keep their original relative order) rather than
    /// throwing on a formulary row with a non-numeric dose value.</summary>
    private static IReadOnlyList<Vaccine> OrderByDose(IEnumerable<Vaccine> doseRows) =>
        doseRows
            .Select((vaccine, index) => (Vaccine: vaccine, Index: index))
            .OrderBy(x => int.TryParse(x.Vaccine.Dose, out var dose) ? dose : int.MaxValue)
            .ThenBy(x => x.Index)
            .Select(x => x.Vaccine)
            .ToList();

    private void GoBack()
    {
        switch (CurrentStage)
        {
            case Stage.Review:
                SelectedVaccine = null;
                CurrentStage = SelectedProduct?.IsMultiDose == true ? Stage.Dose : Stage.Product;
                break;
            case Stage.Dose:
                SelectedProduct = null;
                DoseOptions.Clear();
                CurrentStage = Stage.Product;
                break;
            case Stage.Product:
                SelectedGroup = null;
                ProductOptions.Clear();
                CurrentStage = Stage.Group;
                break;
            case Stage.Group:
                AvailableGroups.Clear();
                _eligibleVaccinesForAge = Array.Empty<Vaccine>();
                CurrentStage = Stage.Age;
                break;
            case Stage.Age:
                break; // BackCommand's CanExecute already excludes this — no-op if reached anyway
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

    /// <summary>V-... Part C: (re)loads the earliest-expiration active lot
    /// for SelectedVaccine. Guards against a slow response landing after
    /// the user has already moved on to a different vaccine by re-checking
    /// SelectedVaccine's id once the call returns.</summary>
    private async Task RefreshSelectedVaccineActiveLotAsync()
    {
        if (SelectedVaccine is null)
        {
            SelectedVaccineActiveLot = null;
            return;
        }

        var vaccineId = SelectedVaccine.Id;
        try
        {
            var activeLots = await _apiService.GetLotsAsync(vaccineId, status: "active");
            if (SelectedVaccine?.Id != vaccineId) return; // selection moved on while this was in flight
            SelectedVaccineActiveLot = activeLots.OrderBy(l => l.Expiration).FirstOrDefault();
        }
        catch (Exception ex)
        {
            if (SelectedVaccine?.Id != vaccineId) return;
            ErrorMessage = $"Couldn't check lot status: {ex.Message}";
        }
    }

    private async Task AddLotAsync()
    {
        if (SelectedVaccine is null || string.IsNullOrWhiteSpace(NewLotNumber)) return;

        IsBusy = true;
        ErrorMessage = null;
        try
        {
            var expiration = DateOnly.FromDateTime(NewLotExpiration);
            var created = await _apiService.CreateLotAsync(SelectedVaccine.Id, NewLotNumber.Trim(), expiration, note: NewLotNote);
            await RefreshSelectedVaccineActiveLotAsync();
            NewLotNumber = "";
            NewLotNote = null;
            StatusMessage = $"Added lot {created.LotNumber} for {SelectedVaccine.Name}.";
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

    private async Task EnterIntoPioneerAsync()
    {
        if (!Gate.CanEnterIntoPioneer || SelectedVaccine is null) return;
        if (IsLotExpiredOrMissing && !SkipLotAndExpiration) return;

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

    /// <summary>V-... Part A: runs UiaTreeDumper on a background thread (a
    /// full tree walk is real, if brief, UIA/COM work — see UiaTreeDumper's
    /// own doc comment) and surfaces the result the same way every other
    /// command here does (StatusMessage on success, ErrorMessage on
    /// failure), plus copies the saved file's path to the clipboard so Will
    /// doesn't have to navigate to %AppData% by hand to find it.</summary>
    private async Task DumpUiaTreeAsync()
    {
        IsBusy = true;
        ErrorMessage = null;
        try
        {
            var outcome = await Task.Run(UiaTreeDumper.DumpAttachedPioneerWindow);
            if (outcome.Success && outcome.FilePath is not null)
            {
                _clipboardService.SetText(outcome.FilePath);
                StatusMessage = outcome.Message;
            }
            else
            {
                ErrorMessage = outcome.Message;
            }
        }
        catch (Exception ex)
        {
            ErrorMessage = $"Couldn't dump the UIA tree: {ex.Message}";
        }
        finally
        {
            IsBusy = false;
        }
    }

    /// <summary>
    /// Builds the Pioneer entry payload for the currently selected vaccine.
    /// FEFO (earliest expiration first, the standard inventory-rotation
    /// rule) among UNEXPIRED active lots only — V-... Part C tightened this
    /// from "any active lot" to "any active, unexpired lot": the popup's
    /// expiration gate (IsLotExpiredOrMissing) is supposed to stop an
    /// expired lot from ever reaching here at all, but this is the same
    /// belt-and-suspenders double-check BuildPayloadAsync already did for
    /// "no lot at all" before this change. Returns null (with ErrorMessage
    /// set) if none is on file and SkipLotAndExpiration wasn't chosen.
    /// </summary>
    private async Task<VaccineEntryPayload?> BuildPayloadAsync()
    {
        if (SelectedVaccine is null)
        {
            ErrorMessage = "Select a vaccine first.";
            return null;
        }

        if (SkipLotAndExpiration)
        {
            return new VaccineEntryPayload(SelectedVaccine.ShortCode, "", "", AdminSite.ToDisplayText(), SkipLotAndExpiration: true);
        }

        var activeLots = await _apiService.GetLotsAsync(SelectedVaccine.Id, status: "active");
        var lot = activeLots.Where(l => !l.IsExpired).OrderBy(l => l.Expiration).FirstOrDefault();
        if (lot is null)
        {
            ErrorMessage = $"No unexpired lot on file for {SelectedVaccine.Name} — add one below, or choose \"Leave lot/expiration blank\" to continue without one.";
            return null;
        }

        return new VaccineEntryPayload(SelectedVaccine.ShortCode, lot.LotNumber, lot.ExpirationMacroFormat, AdminSite.ToDisplayText());
    }
}
