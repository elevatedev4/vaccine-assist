using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Diagnostics;
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
/// Backs the Ctrl+NumPad7 data-entry popup (V-T3, the headline feature —
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
    private bool _updateCurrentLotToThis;
    private string _newLotNumber = "";
    private DateTime _newLotExpiration = DateTime.Today.AddYears(1);
    private string? _newLotNote;

    /// <summary>
    /// MSG893 item 3 fix: monotonic guard against out-of-order lot-status
    /// responses. Bumped every time RefreshSelectedVaccineActiveLotAsync
    /// starts a new lookup (including a rapid re-selection of the SAME
    /// vaccine, which the old "did SelectedVaccine.Id change?" check could
    /// not detect at all); a completing lookup only applies its result if
    /// its own token still matches — an older, slower response for a
    /// selection the user has since moved away from is silently dropped
    /// instead of overwriting whatever a newer lookup already found.
    /// </summary>
    private int _lotRefreshToken;

    /// <summary>
    /// V-..., 2026-09-11 ("Start faster" — Will's feedback: "huge delay
    /// between me pushing 'enter into pioneer' and anything happening"):
    /// (vaccine id, age) key for the cached ResolvePhysicianAsync/active-lot
    /// lookups below — EnsurePioneerEntryPrefetchStarted only starts fresh
    /// tasks when this doesn't match the CURRENT selection, so a re-check
    /// (e.g. EnterIntoPioneerAsync's own defensive call right before it
    /// needs the result) is a cache hit, not a second round trip. Null
    /// until the first prefetch starts.
    /// </summary>
    private (Guid VaccineId, int AgeYears)? _pioneerEntryPrefetchKey;

    /// <summary>
    /// Cached ResolvePhysicianAsync task for _pioneerEntryPrefetchKey.
    /// DELIBERATELY NOT started from the SelectedVaccine/PatientAgeYears
    /// setters (i.e. NOT as early as the Review stage, despite Will's brief
    /// suggesting exactly that as the "better" option) — PhysicianResolutionGateTests.
    /// CopyToClipboardDoesNotRequireAResolvedPhysician asserts
    /// ResolvePhysicianCallCount stays 0 for a clipboard-only session with
    /// no Physicians rule configured (BuildPayloadAsync's own doc comment:
    /// "staff without a Physicians rule set up yet must still be able to
    /// fall back to copy/paste"). Prefetching on selection would call
    /// ResolvePhysicianAsync for EVERY selection regardless of which button
    /// staff eventually press, breaking that isolation. Instead started
    /// from EnterIntoPioneerAsync itself, right after its guard clauses —
    /// still well before BuildLivePayloadAsync's own await, so it runs
    /// CONCURRENTLY with the "Update current lots to this lot"/VAR-confirm
    /// work that can precede it (including a modal await for the
    /// pharmacist's confirmation) instead of only starting after all of
    /// that finishes.
    /// </summary>
    private Task<Physician?>? _prefetchedPhysicianTask;

    /// <summary>Cached active-lot lookup (same filter BuildPayloadAsync always used: unexpired and not past its beyond-use date) for _pioneerEntryPrefetchKey — see _prefetchedPhysicianTask's doc comment; the two run concurrently via Task.WhenAll in BuildLivePayloadAsync instead of one after the other.</summary>
    private Task<Lot?>? _prefetchedLotTask;

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
        EnterIntoPioneerCommand = new AsyncRelayCommand(EnterIntoPioneerAsync, () => !IsBusy && Gate.CanEnterIntoPioneer && (!IsLotExpiredOrMissing || SkipLotAndExpiration || CanUpdateCurrentLotToThis));
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
                UpdateCurrentLotToThis = false;
                NewLotNumber = "";
                NewLotNote = null;
                SelectedVaccineActiveLot = null;
                OnPropertyChanged(nameof(IsLotExpiredOrMissing));
                OnPropertyChanged(nameof(LotGateMessage));
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
                OnPropertyChanged(nameof(LotGateMessage));
            }
        }
    }

    /// <summary>
    /// True when a vaccine is selected and either no active lot is on file
    /// for it, the earliest one on file is already expired, OR (Will,
    /// 2026-09-07: "entry must HALT when the chosen vaccine's lot is
    /// expired OR past its beyond-use date") that lot is past its
    /// beyond-use date — the popup's expiration gate
    /// (Views/DataEntryPopupWindow.xaml) shows the "add a lot" mini-form
    /// plus "leave blank and proceed" affordance whenever this is true,
    /// and EnterIntoPioneerCommand is blocked unless SkipLotAndExpiration
    /// is also true. See LotGateMessage for the block text shown for each
    /// of these three cases.
    /// </summary>
    public bool IsLotExpiredOrMissing =>
        SelectedVaccine is not null &&
        (SelectedVaccineActiveLot is null || SelectedVaccineActiveLot.IsExpired || SelectedVaccineActiveLot.IsPastBeyondUseDate);

    /// <summary>
    /// The expiration gate's inline block message (bound from
    /// Views/DataEntryPopupWindow.xaml, replacing that view's old static
    /// "No unexpired lot on file for this vaccine." text) — covers all
    /// three IsLotExpiredOrMissing cases. The expired/BUD-past cases both
    /// additionally tell staff to have the pharmacist update the VAR
    /// (Will's brief, verbatim: "alert them to tell the pharmacist to
    /// update the VAR") — a lot that was never entered has no VAR entry
    /// yet to update, so that line is specific to the two "was fine, now
    /// isn't" cases. Empty string when the gate isn't active (no vaccine
    /// selected, or the active lot is fine) — the XAML block itself is
    /// only visible when IsLotExpiredOrMissing is true, so this is never
    /// shown otherwise.
    /// </summary>
    public string LotGateMessage
    {
        get
        {
            var lot = SelectedVaccineActiveLot;
            if (lot is null)
            {
                return "No unexpired lot on file for this vaccine. Add one below, or choose \"Leave lot/expiration blank\" to continue without one.";
            }
            if (lot.IsExpired)
            {
                return "This lot has EXPIRED. Update it below, and tell the pharmacist to update the VAR.";
            }
            if (lot.IsPastBeyondUseDate)
            {
                return "This lot is past its beyond-use date. Update it below, and tell the pharmacist to update the VAR.";
            }
            return "";
        }
    }

    /// <summary>
    /// V-T21 item 5 (Will, 2026-09-08): "replace the skip button with two
    /// checkboxes" — this is the second one, "Leave lot/expiration blank
    /// and proceed" (Views/DataEntryPopupWindow.xaml's CheckBox binds
    /// IsChecked here TwoWay; SkipLotAndExpirationCommand is kept as an
    /// alternate way to set it, e.g. for any other caller/test, but the
    /// checkbox binding is the primary path now — this setter is public
    /// for exactly that binding). Checking it also unchecks
    /// UpdateCurrentLotToThis (the two are mutually exclusive: either
    /// enter a lot to save, or explicitly proceed without one — never
    /// both at once). Reset to false every time SelectedVaccine changes
    /// (a fresh product/dose selection must not silently inherit a
    /// previous one's "proceed without a lot" choice). See
    /// VaccineEntryPayload.SkipLotAndExpiration's doc comment for how this
    /// reaches the Pioneer entry sequence.
    /// </summary>
    public bool SkipLotAndExpiration
    {
        get => _skipLotAndExpiration;
        set
        {
            if (SetProperty(ref _skipLotAndExpiration, value) && value)
            {
                UpdateCurrentLotToThis = false;
            }
        }
    }

    /// <summary>
    /// V-T21 item 5: the FIRST of the two checkboxes, "Update current
    /// lots to this lot" — when checked (and NewLotNumber is non-blank),
    /// EnterIntoPioneerAsync saves the typed lot number/expiration via the
    /// lots API as this vaccine's current lot AND deletes every other lot
    /// on file for it (see ApplyUpdateCurrentLotToThisAsync), THEN
    /// proceeds with entry — deferred to "on proceed" rather than an
    /// immediate separate save, per the brief. Checking it also unchecks
    /// SkipLotAndExpiration (mutually exclusive — see that property's own
    /// doc comment). Reset to false on SelectedVaccine change and again
    /// once ApplyUpdateCurrentLotToThisAsync succeeds.
    /// </summary>
    public bool UpdateCurrentLotToThis
    {
        get => _updateCurrentLotToThis;
        set
        {
            if (SetProperty(ref _updateCurrentLotToThis, value) && value)
            {
                SkipLotAndExpiration = false;
            }
        }
    }

    /// <summary>True when UpdateCurrentLotToThis is checked AND a lot
    /// number has actually been typed — the same "can this checkbox
    /// stand in for a real lot on file" gate EnterIntoPioneerCommand's
    /// CanExecute and EnterIntoPioneerAsync's guard both use.</summary>
    private bool CanUpdateCurrentLotToThis => UpdateCurrentLotToThis && !string.IsNullOrWhiteSpace(NewLotNumber);

    /// <summary>
    /// V-T21 item 6 (Will, 2026-09-08, verbatim): "The pharmacist update
    /// VAR prompt needs to be a popup not just a little text prompt."
    /// True only for the two "was fine, now isn't" LotGateMessage cases —
    /// an expired or past-beyond-use-date active lot — NOT the "no lot on
    /// file at all" case, which has no VAR entry yet to update (see
    /// LotGateMessage's own doc comment on that distinction). Drives
    /// whether EnterIntoPioneerAsync must get an affirmative
    /// ConfirmVarUpdateRequested response before it will actually proceed.
    /// </summary>
    public bool RequiresVarUpdateConfirmation =>
        SelectedVaccineActiveLot is Lot lot && (lot.IsExpired || lot.IsPastBeyondUseDate);

    /// <summary>
    /// Set by DataEntryPopupWindow (the View) to show the real modal
    /// dialog — a message, a checkbox ("I have asked the pharmacist to
    /// update the VAR"), and OK (enabled only once checked)/Cancel. Takes
    /// the current LotGateMessage text to show; returns true only when the
    /// user checked the box and clicked OK. FAILS CLOSED when nothing is
    /// wired (null): this is a safety gate, so a missing hookup must never
    /// silently let entry through — the real popup path (DataEntryPopupWindow's
    /// constructor) always sets this, and tests that need to get past this
    /// gate wire a fake delegate explicitly, which keeps every such test
    /// honest about exercising it.
    /// </summary>
    public Func<string, bool>? ConfirmVarUpdateRequested { get; set; }

    /// <summary>
    /// V-..., 2026-09-10: set by DataEntryPopupWindow (the View) to show
    /// the real blank-Quantity/blank-Directions prompt (Views/
    /// TextEntryPromptWindow) — same "set by the View, fails closed when
    /// unwired" shape as ConfirmVarUpdateRequested above. EnterIntoPioneerAsync
    /// forwards this onto PioneerEntryStepContext.RequestTextPrompt when it
    /// builds the context, so InputQuantityStep/InputDirectionsStep never
    /// need to know about WPF at all — see those steps' own doc comments.
    /// Args: title, message, allowSkip.
    /// </summary>
    public Func<string, string, bool, TextPromptResult>? RequestTextPromptRequested { get; set; }

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
            BuildAvailableGroups();

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
        BuildProductOptions(group);
        CurrentStage = Stage.Product;
    }

    public void SelectProduct(VaccineProductOption product)
    {
        SelectedProduct = product;

        if (product.IsMultiDose)
        {
            BuildDoseOptions(product);
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

    /// <summary>(Re)builds AvailableGroups from _eligibleVaccinesForAge —
    /// used both by ContinueFromAgeAsync (first entry into the Group stage)
    /// and by GoBack (re-entry from Product). ALWAYS Clear()s before
    /// re-Add()ing, even when the resulting list is identical to what was
    /// already there — see the reviewer note on GoBack below for why that
    /// Clear+Add (not a no-op skip) is the actual fix, not an optimization
    /// detail.</summary>
    private void BuildAvailableGroups()
    {
        var groupsPresent = _eligibleVaccinesForAge.Select(VaccineGroupCatalog.GetGroup).ToHashSet();
        AvailableGroups.Clear();
        foreach (var group in VaccineGroupCatalog.DisplayOrder.Where(groupsPresent.Contains))
        {
            AvailableGroups.Add(group);
        }
    }

    /// <summary>(Re)builds ProductOptions for one group from
    /// _eligibleVaccinesForAge — used both by SelectGroup (first entry into
    /// the Product stage) and by GoBack (re-entry from Dose, or from
    /// Review for a single-dose product). See BuildAvailableGroups' doc on
    /// why this always rebuilds rather than reusing an existing list.</summary>
    private void BuildProductOptions(string group)
    {
        ProductOptions.Clear();
        var inGroup = _eligibleVaccinesForAge.Where(v => VaccineGroupCatalog.GetGroup(v) == group);
        foreach (var name in inGroup.Select(v => v.Name).Distinct())
        {
            var doseRows = OrderByDose(inGroup.Where(v => v.Name == name));
            ProductOptions.Add(new VaccineProductOption(name, doseRows));
        }
    }

    /// <summary>(Re)builds DoseOptions for one product — used both by
    /// SelectProduct (first entry into the Dose stage) and by GoBack
    /// (re-entry from Review). See BuildAvailableGroups' doc on why this
    /// always rebuilds rather than reusing an existing list.</summary>
    private void BuildDoseOptions(VaccineProductOption product)
    {
        DoseOptions.Clear();
        foreach (var doseRow in product.DoseRows)
        {
            DoseOptions.Add(doseRow);
        }
    }

    /// <summary>
    /// REVIEWER FIX (BLOCKER 2, request-changes round): every back-step
    /// that RE-ENTERS a stage with a RadioButton ItemsControl must rebuild
    /// that stage's collection (Clear() then re-Add(), even when the
    /// resulting items are identical to before) rather than merely
    /// clearing the SELECTION state. Reason: DataEntryPopupWindow.xaml's
    /// RadioButtons are generated per-item by an ItemsControl DataTemplate,
    /// and WPF does NOT raise RadioButton.Checked when a user clicks a
    /// RadioButton that is ALREADY IsChecked=true — clearing only
    /// SelectedGroup/SelectedProduct/SelectedVaccine leaves the OLD,
    /// already-checked RadioButton controls sitting in the visual tree
    /// untouched, so re-picking the exact same (or, for a single-option
    /// stage like HPV -> Gardasil or Shingles -> Shingrix, the ONLY
    /// possible) option after Back never fires the Checked handler again —
    /// a dead end. A Clear() on an ObservableCollection raises
    /// NotifyCollectionChangedAction.Reset, which makes the bound
    /// ItemsControl discard every existing item container; the following
    /// Add() calls then generate BRAND NEW RadioButtons that start
    /// unchecked, so a re-pick is a genuine unchecked->checked transition
    /// again. (Considered instead binding each RadioButton's IsChecked via
    /// a MultiBinding/converter comparing the item to the VM's current
    /// selection — rejected here: WPF's own GroupName-based mutual-
    /// exclusion logic also writes IsChecked directly on sibling
    /// RadioButtons, and reconciling that against a bound OneWay value
    /// without a live PioneerRx-free WPF environment to actually click
    /// through wasn't a risk worth taking over this smaller, already-
    /// proven-safe Clear+rebuild approach — SelectGroup/SelectProduct
    /// already relied on exactly this Clear+Add mechanism for their own
    /// forward transitions before this fix, just not on the BACKWARD ones.)
    ///
    /// WHAT ONLY A LIVE RUN CAN PROVE: VM-level tests (see
    /// DataEntryPopupViewModelGuidedFlowTests.cs's "Back...Rebuilds..."
    /// tests) confirm the Reset+Add collection-change sequence fires and
    /// that SelectGroup/SelectProduct/SelectDose still transition stages
    /// correctly afterward — that's the mechanism this fix relies on. What
    /// they CANNOT observe (no live WPF renderer in this environment) is
    /// that a real RadioButton's on-screen checked state visually clears
    /// and that an actual mouse click on the newly generated control fires
    /// Checked end-to-end. Will should click through a Back step on a
    /// single-option group (e.g. Shingles) on a real run to confirm.
    /// </summary>
    private void GoBack()
    {
        switch (CurrentStage)
        {
            case Stage.Review:
            {
                var previousProduct = SelectedProduct;
                SelectedVaccine = null;
                if (previousProduct?.IsMultiDose == true)
                {
                    BuildDoseOptions(previousProduct);
                    CurrentStage = Stage.Dose;
                }
                else
                {
                    if (SelectedGroup is not null) BuildProductOptions(SelectedGroup);
                    CurrentStage = Stage.Product;
                }
                break;
            }
            case Stage.Dose:
                SelectedProduct = null;
                DoseOptions.Clear();
                if (SelectedGroup is not null) BuildProductOptions(SelectedGroup);
                CurrentStage = Stage.Product;
                break;
            case Stage.Product:
                SelectedGroup = null;
                ProductOptions.Clear();
                BuildAvailableGroups();
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
    /// for SelectedVaccine — MSG893 item 3: now via FindActiveLotForVaccineAsync
    /// so a known-orphan-duplicate vaccine row with no lot of its own
    /// still resolves to the real lot (see that method's doc comment).
    /// Guards against a slow response landing after the user has already
    /// moved on to a different vaccine (or re-selected the SAME one again)
    /// via _lotRefreshToken — a plain "did SelectedVaccine.Id change?"
    /// check (the old guard) can't catch the second case at all.</summary>
    private async Task RefreshSelectedVaccineActiveLotAsync()
    {
        var token = ++_lotRefreshToken;

        // V-..., 2026-09-11: this is the one choke point every lot change
        // (a fresh SelectedVaccine, or AddLotAsync/ApplyUpdateCurrentLotToThisAsync
        // adding/replacing a lot for the CURRENT vaccine) already runs
        // through, so it's also where the physician+lot prefetch cache
        // (EnsurePioneerEntryPrefetchStarted) gets invalidated — a stale
        // cached lot lookup from before this refresh must never win over
        // whatever the lot status actually is now. Runs synchronously
        // (before this method's first await), so a caller that immediately
        // re-starts the prefetch right after (SelectedVaccine's setter)
        // sees the invalidated key, not a stale one.
        _pioneerEntryPrefetchKey = null;

        if (SelectedVaccine is null)
        {
            SelectedVaccineActiveLot = null;
            return;
        }

        var vaccine = SelectedVaccine;
        try
        {
            var lot = await FindActiveLotForVaccineAsync(vaccine);
            if (token != _lotRefreshToken) return; // superseded by a newer lookup

            SelectedVaccineActiveLot = lot;
            if (lot is null)
            {
                AppFileLog.Log($"[DataEntry] No active lot on file for '{vaccine.Name}' (id {vaccine.Id}), " +
                    "including any duplicate vaccine rows checked — showing the \"no lot on file\" gate.");
            }
        }
        catch (Exception ex)
        {
            if (token != _lotRefreshToken) return;
            ErrorMessage = $"Couldn't check lot status: {ex.Message}";
        }
    }

    /// <summary>
    /// MSG893 item 3 ("mNEXSPIKE lot/exp not showing up right"): looks up
    /// the earliest-expiration active lot for `vaccine` by id first — the
    /// normal, expected path. KNOWN DATA ISSUE (Will): the Supabase
    /// `vaccine` table has orphan duplicate rows for at least one product
    /// (same/similar name, e.g. an mNEXSPIKE year-suffix split) where a
    /// lot was only ever added against ONE of the duplicate rows — a data
    /// cleanup tracked and handled SEPARATELY, deliberately NOT touched
    /// here. Left as-is, the guided flow's own grouping
    /// (BuildProductOptions groups eligible vaccines by exact Name, so two
    /// orphan rows sharing a name land as two near-identical "Dose"
    /// options at the Dose step) means a pharmacist can end up with the
    /// lot-less duplicate row selected and see a false "no lot on file"
    /// gate for a product that DOES have one on file — just under its
    /// sibling row's id.
    ///
    /// Mitigation: if the direct id lookup comes back empty, this falls
    /// back to every OTHER vaccine already loaded in _eligibleVaccinesForAge
    /// (no extra vaccine-catalog round trip — that list is already the
    /// exact set the guided flow drew this selection from) that shares
    /// this vaccine's Name (case-insensitive), and returns the first lot
    /// found there instead. `filter` lets callers narrow which lots count
    /// — RefreshSelectedVaccineActiveLotAsync passes none (the review gate
    /// wants to see even an expired/BUD-past lot, so it can show the
    /// right "expired"/"past its beyond-use date" message), while
    /// BuildPayloadAsync passes "unexpired and not past its beyond-use
    /// date" (a live entry must never use a lot the gate would have
    /// blocked). Logs whenever the fallback is what actually found
    /// something, so a real occurrence of this is diagnosable from
    /// "Copy logs" without a live repro.
    /// </summary>
    private async Task<Lot?> FindActiveLotForVaccineAsync(Vaccine vaccine, Func<Lot, bool>? filter = null)
    {
        filter ??= static _ => true;

        async Task<Lot?> EarliestActiveLotForAsync(Guid vaccineId)
        {
            var lots = await _apiService.GetLotsAsync(vaccineId, status: "active");
            return lots.Where(filter).OrderBy(l => l.Expiration).FirstOrDefault();
        }

        var direct = await EarliestActiveLotForAsync(vaccine.Id);
        if (direct is not null) return direct;

        var siblingIds = _eligibleVaccinesForAge
            .Where(v => v.Id != vaccine.Id && string.Equals(v.Name, vaccine.Name, StringComparison.OrdinalIgnoreCase))
            .Select(v => v.Id)
            .Distinct();

        foreach (var siblingId in siblingIds)
        {
            var siblingLot = await EarliestActiveLotForAsync(siblingId);
            if (siblingLot is not null)
            {
                AppFileLog.Log($"[DataEntry] '{vaccine.Name}' (id {vaccine.Id}) has no lot on file, but a " +
                    $"duplicate vaccine row (id {siblingId}) does — using lot {siblingLot.LotNumber} from it " +
                    "(known orphan-duplicate-vaccine-row issue; data cleanup pending separately).");
                return siblingLot;
            }
        }

        return null;
    }

    /// <summary>
    /// Starts (or reuses) the physician-resolution + active-lot lookups a
    /// live "Enter into Pioneer" run needs, running them CONCURRENTLY
    /// rather than one after the other — V-..., 2026-09-11 ("Start faster":
    /// Will's brief asked for BuildLivePayloadAsync's two independent
    /// awaits to run in parallel).
    ///
    /// Called from EnterIntoPioneerAsync itself, right after its guard
    /// clauses (deliberately NOT from the SelectedVaccine/PatientAgeYears
    /// setters — see _prefetchedPhysicianTask's own doc comment for why
    /// that "prefetch at Review stage" version of this would call
    /// ResolvePhysicianAsync for every selection, including a
    /// clipboard-only session that must never require one) — so the two
    /// lookups run WHILE "Update current lots to this lot"/the VAR-confirm
    /// modal (both of which can precede BuildLivePayloadAsync and the
    /// VAR-confirm modal specifically waits on the pharmacist) are still in
    /// flight, rather than only starting once BuildLivePayloadAsync itself
    /// runs. Called again, defensively, from BuildLivePayloadAsync right
    /// before it needs the results — a cache hit there is instant; a cache
    /// miss (e.g. a lot just changed and RefreshSelectedVaccineActiveLotAsync
    /// invalidated the key) just starts the lookups a little late, same as
    /// the old sequential code always did.
    ///
    /// Keyed by (vaccine id, age) so re-selecting a DIFFERENT vaccine/dose,
    /// or changing the age, invalidates the cache and starts fresh lookups
    /// instead of awaiting stale ones for the wrong vaccine.
    /// </summary>
    private void EnsurePioneerEntryPrefetchStarted()
    {
        if (SelectedVaccine is null || PatientAgeYears is not int age) return;

        var key = (VaccineId: SelectedVaccine.Id, AgeYears: age);
        // Written out as .HasValue/.Value.Field comparisons (rather than
        // `_pioneerEntryPrefetchKey == key`, comparing a nullable tuple
        // against a plain one) purely to keep this reviewer-verifiable by
        // reading alone, with no compiler on hand for this change.
        if (_pioneerEntryPrefetchKey.HasValue
            && _pioneerEntryPrefetchKey.Value.VaccineId == key.VaccineId
            && _pioneerEntryPrefetchKey.Value.AgeYears == key.AgeYears
            && _prefetchedPhysicianTask is not null && _prefetchedLotTask is not null)
        {
            return; // already running (or finished) for this exact selection
        }

        _pioneerEntryPrefetchKey = key;
        var vaccine = SelectedVaccine;
        _prefetchedPhysicianTask = _apiService.ResolvePhysicianAsync(vaccine.Id, age);
        _prefetchedLotTask = FindActiveLotForVaccineAsync(vaccine, l => !l.IsExpired && !l.IsPastBeyondUseDate);
    }

    /// <summary>Shared per-step log sink — StepLog (the on-screen list) plus
    /// AppFileLog (so "Copy logs" still has it after StepLog.Clear() — see
    /// CopyLogsCommand's doc comment). Extracted from EnterIntoPioneerAsync's
    /// old inline closure so BuildLivePayloadAsync's own prefetch-timing
    /// line (V-..., 2026-09-11 "show where time goes") can log through the
    /// same sink before PioneerEntryStepContext even exists.</summary>
    private void LogStepMessage(string message)
    {
        StepLog.Add(message);
        AppFileLog.Log($"[DataEntry] {message}");
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
            // REVIEWER FIX (BLOCKER 1, request-changes round): a lot just
            // got added for real — any earlier "leave lot/expiration
            // blank and proceed" choice for THIS vaccine is now stale and
            // must not silently win over the real lot BuildPayloadAsync
            // would otherwise use. Reset before refreshing the lot status
            // below, not after, so there's no window where both are true
            // at once.
            SkipLotAndExpiration = false;
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

    /// <summary>
    /// V-T21 item 5: applies the "Update current lots to this lot"
    /// checkbox — saves NewLotNumber/NewLotExpiration via CreateLotAsync,
    /// then DELETES every OTHER lot on file for SelectedVaccine (via the
    /// new DeleteLotAsync — see IVaccineApiService's own doc comment) so
    /// the freshly typed lot genuinely becomes "the vaccine's current
    /// lot," not just one of several. Called from EnterIntoPioneerAsync
    /// before the VAR-confirmation gate/payload build — see that method's
    /// doc comment for why this must run first. Returns false (having
    /// already set ErrorMessage) on any failure, same "never build an
    /// unsafe payload" posture as BuildPayloadAsync/BuildLivePayloadAsync.
    /// </summary>
    private async Task<bool> ApplyUpdateCurrentLotToThisAsync()
    {
        if (SelectedVaccine is null || string.IsNullOrWhiteSpace(NewLotNumber))
        {
            ErrorMessage = "Enter a lot number first.";
            return false;
        }

        try
        {
            var expiration = DateOnly.FromDateTime(NewLotExpiration);
            var created = await _apiService.CreateLotAsync(SelectedVaccine.Id, NewLotNumber.Trim(), expiration, note: NewLotNote);

            var existingLots = await _apiService.GetLotsAsync(SelectedVaccine.Id);
            foreach (var lot in existingLots.Where(l => l.Id != created.Id))
            {
                await _apiService.DeleteLotAsync(lot.Id);
            }

            UpdateCurrentLotToThis = false;
            NewLotNumber = "";
            NewLotNote = null;
            await RefreshSelectedVaccineActiveLotAsync();
            return true;
        }
        catch (Exception ex)
        {
            ErrorMessage = $"Couldn't update the current lot: {ex.Message}";
            return false;
        }
    }

    /// <summary>
    /// V-..., 2026-09-10: shared body for PioneerEntryStepContext.SaveQuantityAsync/
    /// SaveDirectionsAsync — a failed save must not abort the entry
    /// (Will's brief, verbatim), so this swallows any exception and
    /// returns false rather than letting it propagate; InputQuantityStep/
    /// InputDirectionsStep log whichever outcome comes back. `save` is the
    /// specific UpdateVaccineQuantityAsync/UpdateVaccineDirectionsAsync
    /// call, already closed over this run's vaccine id and the new value.
    /// </summary>
    private static async Task<bool> SaveVaccineFieldAsync(Func<Task<Vaccine>> save)
    {
        try
        {
            await save();
            return true;
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("DataEntryPopupViewModel.SaveVaccineFieldAsync", ex);
            return false;
        }
    }

    private async Task EnterIntoPioneerAsync()
    {
        if (!Gate.CanEnterIntoPioneer || SelectedVaccine is null) return;
        if (IsLotExpiredOrMissing && !SkipLotAndExpiration && !CanUpdateCurrentLotToThis) return;

        // V-..., 2026-09-11 ("Show where time goes" — Will: "huge delay
        // between me pushing 'enter into pioneer' and anything happening"):
        // measures from the click itself to the moment PioneerEntrySequenceRunner
        // actually starts, so the step log can show how much of that delay
        // was VM-side prep (VAR-update/lot work, physician+lot prefetch)
        // versus the sequence's own per-step timing below it.
        var clickToSequenceStartStopwatch = Stopwatch.StartNew();

        IsBusy = true;
        ErrorMessage = null;
        StepLog.Clear();
        try
        {
            // V-..., 2026-09-11 ("start faster"): fires the physician+lot
            // lookups NOW, right at the click, so they run CONCURRENTLY
            // with the "Update current lots to this lot"/VAR-confirm work
            // right below (the VAR-confirm modal specifically waits on the
            // pharmacist) instead of only starting once BuildLivePayloadAsync
            // itself runs — see EnsurePioneerEntryPrefetchStarted's own doc
            // comment for why this isn't started any earlier (at vaccine
            // selection/Review stage). Inside the try block (not before
            // IsBusy is set) so a synchronous failure here still resets
            // IsBusy/reports through this method's existing catch, same as
            // every other failure path below.
            EnsurePioneerEntryPrefetchStarted();

            // V-T21 item 5: "Update current lots to this lot" is applied
            // FIRST, before anything else — once this succeeds,
            // SelectedVaccineActiveLot reflects the fresh lot, so the VAR
            // gate right below naturally won't fire for a lot that was
            // JUST fixed (only for one that's still sitting
            // expired/BUD-past because staff chose to skip it instead).
            if (CanUpdateCurrentLotToThis)
            {
                var updated = await ApplyUpdateCurrentLotToThisAsync();
                if (!updated) return; // ApplyUpdateCurrentLotToThisAsync already set ErrorMessage
            }

            // V-T21 item 6: modal VAR-update confirmation — see
            // RequiresVarUpdateConfirmation/ConfirmVarUpdateRequested's own
            // doc comments.
            if (RequiresVarUpdateConfirmation)
            {
                var confirmed = ConfirmVarUpdateRequested?.Invoke(LotGateMessage) ?? false;
                if (!confirmed)
                {
                    StatusMessage = null;
                    ErrorMessage = "Entry cancelled — confirm the pharmacist has updated the VAR before proceeding.";
                    return;
                }
            }

            var payload = await BuildLivePayloadAsync();
            if (payload is null) return; // BuildLivePayloadAsync already set ErrorMessage

            var vaccineId = SelectedVaccine.Id;
            var context = new PioneerEntryStepContext(payload, IsDryRun, LogStepMessage)
            {
                // V-..., 2026-09-10: forwards the View's blank-value prompt
                // (RequestTextPromptRequested) and closes the "save it back"
                // delegates over THIS run's vaccine id — see
                // PioneerEntryStepContext's own doc comments on all three.
                RequestTextPrompt = RequestTextPromptRequested,
                SaveQuantityAsync = quantity => SaveVaccineFieldAsync(() => _apiService.UpdateVaccineQuantityAsync(vaccineId, quantity)),
                SaveDirectionsAsync = directions => SaveVaccineFieldAsync(() => _apiService.UpdateVaccineDirectionsAsync(vaccineId, directions)),
            };
            LogStepMessage($"[Prep] sequence started {clickToSequenceStartStopwatch.ElapsedMilliseconds}ms after click.");
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
    /// failure), plus copies the DUMP TEXT ITSELF to the clipboard (Will,
    /// 2026-09-05: "copy the log it generates to the clipboard so I don't
    /// have to go find it in the file. That's a waste of time.") — the
    /// file is still written to %AppData% too, this just saves the extra
    /// trip to go find it.</summary>
    private async Task DumpUiaTreeAsync()
    {
        IsBusy = true;
        ErrorMessage = null;
        try
        {
            var outcome = await Task.Run(UiaTreeDumper.DumpAttachedPioneerWindow);
            if (outcome.Success && outcome.Content is not null)
            {
                _clipboardService.SetText(outcome.Content);
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
    /// rule) among UNEXPIRED, non-BUD-past active lots only — V-... Part C
    /// tightened this from "any active lot" to "any active, unexpired
    /// lot"; 2026-09-07 tightened it again to also exclude a lot past its
    /// beyond-use date: the popup's expiration gate (IsLotExpiredOrMissing)
    /// is supposed to stop an expired-or-BUD-past lot from ever reaching
    /// here at all, but this is the same belt-and-suspenders double-check
    /// BuildPayloadAsync already did for "no lot at all" before this
    /// change.
    ///
    /// REVIEWER FIX (BLOCKER 1, request-changes round): this method used to
    /// check SkipLotAndExpiration FIRST and return a blank-lot payload
    /// without ever looking at the lots table at all — so if staff chose
    /// "leave blank and proceed" and THEN added a real lot (AddLotAsync now
    /// resets the flag itself — see that method — but this is the
    /// independent belt-and-suspenders half of the same fix, in case the
    /// flag is ever left stale-true by some other path), the blank payload
    /// still won, silently producing a wrong PioneerRx administration
    /// record (no lot/expiration entered even though a valid one existed).
    /// Now the ACTUAL lot lookup always runs FIRST and wins whenever it
    /// finds one — SkipLotAndExpiration is consulted only as the fallback
    /// for "no unexpired lot exists right now", which is a fresh check
    /// against the API here, not a trust of the (possibly stale)
    /// IsLotExpiredOrMissing/SkipLotAndExpiration view-model state.
    ///
    /// Deliberately does NOT resolve a physician — this is also the
    /// clipboard-fallback path (CopyToClipboardAsync), whose
    /// ToClipboardPayload() output never included physician info even in
    /// the old macro era, and staff without a Physicians rule set up yet
    /// must still be able to fall back to copy/paste. See
    /// BuildLivePayloadAsync for the physician-resolving payload
    /// EnterIntoPioneerAsync actually uses.
    /// </summary>
    /// <param name="prefetchedLotTask">
    /// V-..., 2026-09-11 ("start faster"): BuildLivePayloadAsync passes its
    /// already-running EnsurePioneerEntryPrefetchStarted lot lookup here
    /// instead of letting this method start a SECOND, redundant one — the
    /// lot-decision logic below (found lot wins; else SkipLotAndExpiration;
    /// else block) stays the single source of truth either way. Null (the
    /// default) means "no prefetch available" — CopyToClipboardAsync (which
    /// never resolves a physician and so never prefetches, see this
    /// method's own doc comment) still gets a fresh lookup exactly as
    /// before this change.
    /// </param>
    private async Task<VaccineEntryPayload?> BuildPayloadAsync(Task<Lot?>? prefetchedLotTask = null)
    {
        if (SelectedVaccine is null)
        {
            ErrorMessage = "Select a vaccine first.";
            return null;
        }

        var ndc = SelectedVaccine.Ndc ?? "";
        var quantity = SelectedVaccine.Quantity;
        var directions = SelectedVaccine.Directions;
        // MSG893 item 3: routed through the same orphan-duplicate-aware
        // lookup RefreshSelectedVaccineActiveLotAsync uses (see
        // FindActiveLotForVaccineAsync's doc comment) so a live entry
        // can't disagree with what the popup's own gate just showed.
        var lot = await (prefetchedLotTask ?? FindActiveLotForVaccineAsync(SelectedVaccine, l => !l.IsExpired && !l.IsPastBeyondUseDate));

        if (lot is not null)
        {
            return new VaccineEntryPayload(SelectedVaccine.ShortCode, lot.LotNumber, lot.ExpirationMacroFormat, AdminSite.ToDisplayText(),
                Ndc: ndc, Quantity: quantity, Directions: directions, VaccineName: SelectedVaccine.Name);
        }

        if (SkipLotAndExpiration)
        {
            return new VaccineEntryPayload(SelectedVaccine.ShortCode, "", "", AdminSite.ToDisplayText(),
                Ndc: ndc, SkipLotAndExpiration: true, Quantity: quantity, Directions: directions, VaccineName: SelectedVaccine.Name);
        }

        ErrorMessage = $"No unexpired lot on file for {SelectedVaccine.Name} — add one below, or choose \"Leave lot/expiration blank\" to continue without one.";
        return null;
    }

    /// <summary>
    /// PHYSICIAN RESOLUTION (Will, 2026-09-05): the payload actually used
    /// for a live/dry-run PioneerRx entry sequence — BuildPayloadAsync
    /// (vaccine + lot only) PLUS a resolved protocol physician for the
    /// CURRENT vaccine + age. No matching rule BLOCKS entry entirely
    /// (returns null, same "never build an unsafe payload" posture
    /// BuildPayloadAsync already uses for a missing lot) with a message
    /// pointing staff at the Physicians settings tab, rather than typing an
    /// empty/wrong alternate ID into a real patient's PioneerRx record.
    /// Physician is checked BEFORE the lot result so a missing rule is
    /// reported first — it's the more likely one-time setup gap, while a
    /// missing lot already has its own dedicated gate/add-lot flow the
    /// popup surfaces separately.
    ///
    /// V-..., 2026-09-11 ("start faster" — Will: "huge delay between me
    /// pushing 'enter into pioneer' and anything happening"): the physician
    /// resolution and lot lookup used to run SEQUENTIALLY, one full round
    /// trip after the other. Both are now started as early as
    /// EnterIntoPioneerAsync's own click handler (see
    /// EnsurePioneerEntryPrefetchStarted's doc comment) — normally well
    /// before this method runs, since "Update current lots to this lot"/the
    /// VAR-confirm modal can sit in between — and awaited here TOGETHER via
    /// Task.WhenAll, so the wall-clock cost from THIS point on is whichever
    /// of the two is still-slower to finish, not their sum. The
    /// EnsurePioneerEntryPrefetchStarted call right below is a safety net
    /// for any path that reaches here with no prefetch already running (see
    /// that method's own doc comment), not the normal case.
    /// </summary>
    private async Task<VaccineEntryPayload?> BuildLivePayloadAsync()
    {
        if (SelectedVaccine is null)
        {
            ErrorMessage = "Select a vaccine first.";
            return null;
        }

        if (PatientAgeYears is not int age)
        {
            ErrorMessage = "Enter the patient's age first.";
            return null;
        }

        EnsurePioneerEntryPrefetchStarted();
        var physicianTask = _prefetchedPhysicianTask!;
        var lotTask = _prefetchedLotTask!;

        var prefetchStopwatch = Stopwatch.StartNew();
        await Task.WhenAll(physicianTask, lotTask);
        LogStepMessage($"[Prep] prefetch physician+lots took {prefetchStopwatch.ElapsedMilliseconds}ms.");

        var physician = physicianTask.Result;
        if (physician is null)
        {
            ErrorMessage = $"No protocol physician configured for {SelectedVaccine.Name} at age {age} — " +
                "add one (or a matching rule) in the Physicians settings tab, then try again.";
            return null;
        }

        var payload = await BuildPayloadAsync(lotTask);
        if (payload is null) return null; // BuildPayloadAsync already set ErrorMessage (lot issue)

        return payload with { PhysicianAlternateId = physician.AlternateId };
    }
}
