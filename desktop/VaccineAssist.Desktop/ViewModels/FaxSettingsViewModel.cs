using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Net.Http;
using System.Windows.Input;
using System.Windows.Threading;
using VaccineAssist.Desktop.Common;
using VaccineAssist.Desktop.Fax;
using VaccineAssist.Desktop.Settings;

namespace VaccineAssist.Desktop.ViewModels;

/// <summary>
/// Backs Views/FaxSettingsWindow.xaml. V-T65 (Will's brief, verbatim,
/// 2026-09-29): "Add the save button near the Notifyre key. Everything
/// else should save as it is typed ... It's very unintuitive to have a
/// hidden save button where you have to scroll all the way to the
/// bottom." So every field EXCEPT the provider credentials (SRFax access
/// id/password, Notifyre API token — both PasswordBox-backed, read from
/// code-behind, so they can't debounce-save the way a plain bound
/// TextBox can) auto-saves via AutoSaveFieldsAsync, debounced ~300ms on a
/// text change and immediately on a selection change (Provider dropdown)
/// — see FaxSettingsAutoSavePolicy (pure, unit-tested) for the actual
/// delay decision. The credentials group keeps its own explicit
/// SaveCredentialsCommand (rendered right next to the key box in the
/// XAML), Test connection, and Forget key — unchanged from before this
/// brief.
///
/// Also V-T65: the prescriber-fax directory and the automatic/scheduled
/// run are gone entirely — see FaxRunOrchestrator/FaxRunScheduler's own
/// doc comments. This ViewModel no longer has an IPrescriberDirectory
/// dependency, a Prescribers grid, or InputFolder/DailyRun* fields.
/// </summary>
public sealed class FaxSettingsViewModel : ObservableObject
{
    private readonly AppSettings _settings;
    private readonly ILocalSettingsService _localSettingsService;
    private readonly IFaxCredentialStore _credentialStore;
    private readonly HttpClient _httpClient;

    private readonly DispatcherTimer _autoSaveDebounceTimer;
    private readonly DispatcherTimer _savedHintTimer;

    private FaxProvider _selectedProvider = FaxProvider.Notifyre;
    private string _accessId = "";
    private string _accessPassword = "";
    private string _apiToken = "";
    private string _senderEmail = "";
    private string _pharmacyName = "";
    private string _pharmacyPhone = "";
    private string _pharmacyFax = "";
    private string _pharmacyAddressLine1 = "";
    private string _pharmacyCityStateZip = "";
    private string _signatureName = "";
    private string _accountCode = "";
    private bool _isBusy;
    private string? _statusMessage;
    private string? _errorMessage;
    private string? _autoSaveErrorMessage;
    private bool _isSavedHintVisible;

    /// <summary>The Notifyre token actually on disk right now (from
    /// FaxCredentialStore) — kept separate from the bindable ApiToken
    /// property, which is ONLY ever "whatever's typed in the box THIS
    /// session" (starts blank even when a key IS stored — Notifyre-key-
    /// visibility follow-up, Will 2026-09-28: "leave the token box empty
    /// ... never display the full token"). SaveCredentialsAsync falls
    /// back to this when the box is left blank, so re-saving unrelated
    /// fields (e.g. pharmacy phone) can never accidentally blank out an
    /// already-saved key.</summary>
    private string _storedNotifyreApiToken = "";
    private DateTime? _storedNotifyreTokenSavedAtUtc;

    /// <summary>Which header form Notifyre last proved it accepts this
    /// token in — loaded from the credential store on window open,
    /// updated (and immediately re-persisted, see TestConnectionAsync
    /// below) the moment a Test connection probe finds a non-documented
    /// form works, and carried into SaveCredentialsAsync's credentials
    /// write so a later Save never silently reverts a discovered mode
    /// back to the documented default. See FaxCredentials.NotifyreAuthMode's
    /// own doc comment (V-T53 401 follow-up, 2026-09-25).</summary>
    private NotifyreAuthMode _notifyreAuthMode = NotifyreAuthMode.XApiToken;

    public FaxSettingsViewModel(
        AppSettings settings,
        ILocalSettingsService localSettingsService,
        IFaxCredentialStore credentialStore,
        HttpClient httpClient)
    {
        _settings = settings;
        _localSettingsService = localSettingsService;
        _credentialStore = credentialStore;
        _httpClient = httpClient;

        _autoSaveDebounceTimer = new DispatcherTimer();
        _autoSaveDebounceTimer.Tick += async (_, _) =>
        {
            _autoSaveDebounceTimer.Stop();
            await AutoSaveFieldsAsync();
        };

        _savedHintTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1.5) };
        _savedHintTimer.Tick += (_, _) =>
        {
            _savedHintTimer.Stop();
            IsSavedHintVisible = false;
        };

        SaveCredentialsCommand = new AsyncRelayCommand(SaveCredentialsAsync, () => !IsBusy);
        TestConnectionCommand = new AsyncRelayCommand(TestConnectionAsync, () => !IsBusy);
        ForgetKeyCommand = new AsyncRelayCommand(ForgetKeyAsync, () => !IsBusy && HasStoredNotifyreKey);

        LoadFromCurrentState();
    }

    /// <summary>Raised right after SaveCredentialsAsync (or
    /// ForgetKeyAsync) persists a Notifyre credential/provider change —
    /// MainWindow subscribes to rebuild FaxRunOrchestrator's IFaxClient
    /// from the freshly-stored credentials, so a real send never uses a
    /// stale in-memory token from before this save (see
    /// FaxRunOrchestrator.UpdateFaxClient's own doc comment).</summary>
    public event Action? CredentialsSaved;

    public ObservableCollection<FaxColumnMapRow> ColumnMap { get; } = new();

    /// <summary>Backs the Settings window's provider dropdown.</summary>
    public IReadOnlyList<FaxProvider> Providers { get; } = Enum.GetValues<FaxProvider>();

    public FaxProvider SelectedProvider
    {
        get => _selectedProvider;
        set
        {
            if (SetProperty(ref _selectedProvider, value))
            {
                OnPropertyChanged(nameof(IsSrFaxSelected));
                OnPropertyChanged(nameof(IsNotifyreSelected));
                ScheduleAutoSave(FaxSettingsAutoSavePolicy.ChangeKind.Selection);
            }
        }
    }

    /// <summary>Drives Visibility on the SRFax access id/password fields
    /// in FaxSettingsWindow.xaml.</summary>
    public bool IsSrFaxSelected => SelectedProvider == FaxProvider.SrFax;

    /// <summary>Drives Visibility on the Notifyre API token field in
    /// FaxSettingsWindow.xaml.</summary>
    public bool IsNotifyreSelected => SelectedProvider == FaxProvider.Notifyre;

    /// <summary>SRFax access id — part of the explicit credentials Save
    /// group (same PasswordBox-adjacent group as AccessPassword/ApiToken),
    /// not auto-saved.</summary>
    public string AccessId { get => _accessId; set => SetProperty(ref _accessId, value); }
    public string AccessPassword { get => _accessPassword; set => SetProperty(ref _accessPassword, value); }

    /// <summary>Notifyre's x-api-token value — read from ApiTokenBox in
    /// code-behind on Save/Test connection, same PasswordBox-isn't-
    /// bindable pattern as AccessPassword.</summary>
    public string ApiToken { get => _apiToken; set => SetProperty(ref _apiToken, value); }

    public string SenderEmail
    {
        get => _senderEmail;
        set { if (SetProperty(ref _senderEmail, value)) ScheduleAutoSave(FaxSettingsAutoSavePolicy.ChangeKind.Text); }
    }

    public string PharmacyName
    {
        get => _pharmacyName;
        set { if (SetProperty(ref _pharmacyName, value)) ScheduleAutoSave(FaxSettingsAutoSavePolicy.ChangeKind.Text); }
    }

    public string PharmacyPhone
    {
        get => _pharmacyPhone;
        set { if (SetProperty(ref _pharmacyPhone, value)) ScheduleAutoSave(FaxSettingsAutoSavePolicy.ChangeKind.Text); }
    }

    public string PharmacyFax
    {
        get => _pharmacyFax;
        set { if (SetProperty(ref _pharmacyFax, value)) ScheduleAutoSave(FaxSettingsAutoSavePolicy.ChangeKind.Text); }
    }

    public string PharmacyAddressLine1
    {
        get => _pharmacyAddressLine1;
        set { if (SetProperty(ref _pharmacyAddressLine1, value)) ScheduleAutoSave(FaxSettingsAutoSavePolicy.ChangeKind.Text); }
    }

    public string PharmacyCityStateZip
    {
        get => _pharmacyCityStateZip;
        set { if (SetProperty(ref _pharmacyCityStateZip, value)) ScheduleAutoSave(FaxSettingsAutoSavePolicy.ChangeKind.Text); }
    }

    /// <summary>Printed under "Sincerely," on the letter — see
    /// FaxSettings.SignatureName's own doc comment for the default.</summary>
    public string SignatureName
    {
        get => _signatureName;
        set { if (SetProperty(ref _signatureName, value)) ScheduleAutoSave(FaxSettingsAutoSavePolicy.ChangeKind.Text); }
    }

    public string AccountCode
    {
        get => _accountCode;
        set { if (SetProperty(ref _accountCode, value)) ScheduleAutoSave(FaxSettingsAutoSavePolicy.ChangeKind.Text); }
    }

    public bool IsBusy { get => _isBusy; private set => SetProperty(ref _isBusy, value); }

    /// <summary>Status/error line for the credentials group only (Save/
    /// Test connection/Forget key) — unchanged from before this brief.</summary>
    public string? StatusMessage { get => _statusMessage; private set => SetProperty(ref _statusMessage, value); }
    public string? ErrorMessage { get => _errorMessage; private set => SetProperty(ref _errorMessage, value); }

    /// <summary>Inline validation message for the auto-saved fields (only
    /// the pharmacy fax number is validated) — separate from
    /// ErrorMessage/StatusMessage above so it never fights with the
    /// credentials group's own status line. Never blocks typing or the
    /// auto-save of every OTHER field — see AutoSaveFieldsAsync.</summary>
    public string? AutoSaveErrorMessage { get => _autoSaveErrorMessage; private set => SetProperty(ref _autoSaveErrorMessage, value); }

    /// <summary>Drives a small "Saved" hint that appears briefly after an
    /// auto-save and fades on its own — Will's brief: "Show a small
    /// 'Saved' hint that appears briefly after an auto-save."</summary>
    public bool IsSavedHintVisible { get => _isSavedHintVisible; private set => SetProperty(ref _isSavedHintVisible, value); }

    /// <summary>"No key saved" / "Notifyre key saved (ends …1234, saved
    /// …)" — see FaxKeyStatus.Describe. Bound read-only next to the API
    /// token box; never shows the token itself.</summary>
    public string NotifyreKeyStatusText => FaxKeyStatus.Describe(
        FaxKeyStatus.Last4OfToken(_storedNotifyreApiToken), _storedNotifyreTokenSavedAtUtc);

    /// <summary>Drives the "Forget key" button's enabled state and the
    /// API-token box's "paste a new key to replace" hint text's
    /// visibility.</summary>
    public bool HasStoredNotifyreKey => !string.IsNullOrWhiteSpace(_storedNotifyreApiToken);

    public ICommand SaveCredentialsCommand { get; }
    public ICommand TestConnectionCommand { get; }
    public ICommand ForgetKeyCommand { get; }

    private void LoadFromCurrentState()
    {
        var fax = _settings.Fax;
        SelectedProvider = fax.Provider;
        SenderEmail = fax.SenderEmail;
        PharmacyName = fax.PharmacyName;
        PharmacyPhone = fax.PharmacyPhone;
        PharmacyFax = fax.PharmacyFax;
        PharmacyAddressLine1 = fax.PharmacyAddressLine1;
        PharmacyCityStateZip = fax.PharmacyCityStateZip;
        SignatureName = fax.SignatureName;
        AccountCode = fax.AccountCode ?? "";

        var credentials = _credentialStore.Load();
        AccessId = credentials?.AccessId ?? "";
        AccessPassword = credentials?.AccessPassword ?? "";
        _notifyreAuthMode = credentials?.NotifyreAuthMode ?? NotifyreAuthMode.XApiToken;

        // Notifyre-key-visibility follow-up (Will, 2026-09-28): ApiToken
        // (the bindable box value) starts BLANK even when a key IS
        // stored — see its own field doc comment and
        // FaxSettingsWindow.xaml.cs (no longer prefills ApiTokenBox from
        // this). _storedNotifyreApiToken/_storedNotifyreTokenSavedAtUtc
        // back the read-only "Notifyre key saved ..." status line instead.
        ApiToken = "";
        _storedNotifyreApiToken = credentials?.ApiToken ?? "";
        _storedNotifyreTokenSavedAtUtc = credentials?.NotifyreTokenSavedAtUtc;
        OnPropertyChanged(nameof(NotifyreKeyStatusText));
        OnPropertyChanged(nameof(HasStoredNotifyreKey));

        foreach (var row in ColumnMap)
        {
            row.PropertyChanged -= OnColumnMapRowPropertyChanged;
        }
        ColumnMap.Clear();
        var map = fax.ColumnMap;
        // Pioneer's report (V-T53 401/column-map follow-up) has ONE
        // combined "Last, First" name column rather than separate first/
        // last columns — this row takes priority when filled in (see
        // FaxColumnMap.PatientFullNameHeader's own doc comment); the two
        // separate-column rows below stay in the grid as a fallback for a
        // workstation whose export uses them instead.
        AddColumnMapRow("Patient full name (Last, First)", true, map.PatientFullNameHeader ?? "");
        AddColumnMapRow("Patient first name", false, map.PatientFirstNameHeader);
        AddColumnMapRow("Patient last name", false, map.PatientLastNameHeader);
        AddColumnMapRow("Vaccine name", true, map.VaccineNameHeader);
        AddColumnMapRow("Administered date", true, map.AdministeredDateHeader);
        // REQUIRED (fax-report-layout brief, 2026-09-28) — see
        // FaxColumnMap.DobHeader's own doc comment.
        AddColumnMapRow("DOB", true, map.DobHeader);
        AddColumnMapRow("Lot", false, map.LotHeader ?? "");
        AddColumnMapRow("Manufacturer", false, map.ManufacturerHeader ?? "");
        AddColumnMapRow("Dose", false, map.DoseHeader ?? "");
        AddColumnMapRow("Route", false, map.RouteHeader ?? "");
        AddColumnMapRow("Site", false, map.SiteHeader ?? "");
        AddColumnMapRow("Administering pharmacist", false, map.PharmacistHeader ?? "");
        AddColumnMapRow("Prescriber name", false, map.PrescriberNameHeader ?? "");
        AddColumnMapRow("Prescriber NPI", false, map.PrescriberNpiHeader ?? "");
        AddColumnMapRow("Prescriber fax", false, map.PrescriberFaxHeader ?? "");
        AddColumnMapRow("VIS date", false, map.VisDateHeader ?? "");
    }

    private void AddColumnMapRow(string field, bool required, string header)
    {
        var row = new FaxColumnMapRow { Field = field, Required = required, Header = header };
        row.PropertyChanged += OnColumnMapRowPropertyChanged;
        ColumnMap.Add(row);
    }

    /// <summary>A column-map grid cell edit is a text change like any
    /// other field (Will's brief: "Everything else should save as it is
    /// typed") — debounced the same way.</summary>
    private void OnColumnMapRowPropertyChanged(object? sender, PropertyChangedEventArgs e) =>
        ScheduleAutoSave(FaxSettingsAutoSavePolicy.ChangeKind.Text);

    /// <summary>Restarts (Text) or bypasses (Selection) the debounce
    /// timer per FaxSettingsAutoSavePolicy.DebounceDelayFor — called from
    /// every auto-saved property's setter and from a column-map row edit.</summary>
    private void ScheduleAutoSave(FaxSettingsAutoSavePolicy.ChangeKind kind)
    {
        _autoSaveDebounceTimer.Stop();
        var delay = FaxSettingsAutoSavePolicy.DebounceDelayFor(kind);
        if (delay <= TimeSpan.Zero)
        {
            _ = AutoSaveFieldsAsync();
            return;
        }

        _autoSaveDebounceTimer.Interval = delay;
        _autoSaveDebounceTimer.Start();
    }

    /// <summary>Persists every field except the provider credentials
    /// (SRFax id/password, Notifyre API token) — see class doc comment.
    /// Validation still runs (pharmacy fax number, 10-11 digits) but
    /// NEVER blocks saving the rest of the settings or further typing —
    /// Will's brief verbatim: "Keep validation, but never block
    /// typing."</summary>
    private async Task AutoSaveFieldsAsync()
    {
        try
        {
            AutoSaveErrorMessage = !string.IsNullOrWhiteSpace(PharmacyFax) && !FaxNumberNormalizer.IsValid(PharmacyFax)
                ? "Pharmacy fax number must be 10 or 11 digits."
                : null;

            var fax = _settings.Fax;
            fax.Provider = SelectedProvider;
            fax.SenderEmail = SenderEmail.Trim();
            fax.PharmacyName = PharmacyName.Trim();
            fax.PharmacyPhone = PharmacyPhone.Trim();
            fax.PharmacyFax = PharmacyFax.Trim();
            fax.PharmacyAddressLine1 = PharmacyAddressLine1.Trim();
            fax.PharmacyCityStateZip = PharmacyCityStateZip.Trim();
            fax.SignatureName = SignatureName.Trim();
            fax.AccountCode = string.IsNullOrWhiteSpace(AccountCode) ? null : AccountCode.Trim();
            fax.ColumnMap = BuildColumnMap();

            _localSettingsService.Save(_settings);

            IsSavedHintVisible = true;
            _savedHintTimer.Stop();
            _savedHintTimer.Start();
        }
        catch (Exception ex)
        {
            AutoSaveErrorMessage = $"Couldn't save: {ex.Message}";
        }
    }

    /// <summary>The Notifyre key's (and SRFax's) explicit "Save" button
    /// (Will's brief: "Add the save button near the Notifyre key") —
    /// everything else on this window auto-saves, see AutoSaveFieldsAsync.</summary>
    private async Task SaveCredentialsAsync()
    {
        IsBusy = true;
        ErrorMessage = null;
        StatusMessage = null;
        try
        {
            // V-T53 follow-up (Will, 2026-09-25): normalize BEFORE the
            // blank check too — a token that's nothing but whitespace/
            // zero-width characters/quotes should read as "not entered",
            // same as a literally empty box. See FaxApiTokenNormalizer.
            var typedApiToken = FaxApiTokenNormalizer.Normalize(ApiToken);

            // Notifyre-key-visibility follow-up (Will, 2026-09-28): the
            // box is ALWAYS blank on open now (never prefilled with the
            // real secret — see LoadFromCurrentState), so a blank box
            // here means "keep whatever's already stored", NOT "erase
            // it" — only error out when NOTHING has ever been saved
            // either. A non-blank box always means "replace it with
            // this". See NotifyreKeyPersistencePolicy.DecideSave (pure,
            // unit-tested) for the actual decision.
            var saveDecision = NotifyreKeyPersistencePolicy.DecideSave(typedApiToken, _storedNotifyreApiToken);
            var tokenChanged = saveDecision.TokenChanged;
            var tokenToPersist = saveDecision.TokenToPersist;

            if (SelectedProvider == FaxProvider.Notifyre && !saveDecision.CanSave)
            {
                ErrorMessage = saveDecision.ErrorMessage;
                return;
            }

            if (tokenChanged)
            {
                _storedNotifyreTokenSavedAtUtc = DateTime.UtcNow;
            }
            _storedNotifyreApiToken = tokenToPersist;
            _credentialStore.Save(new FaxCredentials
            {
                AccessId = AccessId.Trim(),
                AccessPassword = AccessPassword,
                ApiToken = tokenToPersist,
                NotifyreAuthMode = _notifyreAuthMode,
                NotifyreTokenSavedAtUtc = _storedNotifyreTokenSavedAtUtc,
            });
            // The box itself always goes back to blank after a save —
            // never re-shows the token that's now on disk.
            ApiToken = "";
            OnPropertyChanged(nameof(NotifyreKeyStatusText));
            OnPropertyChanged(nameof(HasStoredNotifyreKey));

            StatusMessage = "Saved.";
            // MainWindow rebuilds FaxRunOrchestrator's IFaxClient from
            // what was just persisted, so a real send never uses a stale
            // in-memory client built at app-startup credentials.
            CredentialsSaved?.Invoke();
        }
        catch (Exception ex)
        {
            ErrorMessage = $"Couldn't save: {ex.Message}";
        }
        finally
        {
            IsBusy = false;
        }
    }

    /// <summary>"Forget key" button (Will, 2026-09-28) — clears the
    /// stored Notifyre token from disk. The confirm dialog lives in
    /// FaxSettingsWindow.xaml.cs's code-behind (a UI concern), not here —
    /// by the time this runs, Will has already confirmed.</summary>
    private Task ForgetKeyAsync()
    {
        ErrorMessage = null;
        StatusMessage = null;

        var stored = NotifyreKeyPersistencePolicy.ApplyForget(_credentialStore.Load() ?? new FaxCredentials());
        _credentialStore.Save(stored);

        _storedNotifyreApiToken = "";
        _storedNotifyreTokenSavedAtUtc = null;
        OnPropertyChanged(nameof(NotifyreKeyStatusText));
        OnPropertyChanged(nameof(HasStoredNotifyreKey));

        StatusMessage = "Notifyre key removed.";
        // Rebuild the live fax client too — otherwise a run started
        // right after "Forget key" would still send with the
        // just-forgotten token still held in memory.
        CredentialsSaved?.Invoke();
        return Task.CompletedTask;
    }

    private async Task TestConnectionAsync()
    {
        IsBusy = true;
        ErrorMessage = null;
        StatusMessage = null;
        try
        {
            // Notifyre-key-visibility follow-up (Will, 2026-09-28): the
            // box is blank by default now (see LoadFromCurrentState), so
            // "test with whatever's in the box" would silently test with
            // nothing whenever Will hasn't just retyped it — use the
            // BOX when something's typed, otherwise fall back to the
            // STORED key, and say plainly which one was used so Will
            // never has to guess whether an untyped Save is still needed.
            // See NotifyreKeyPersistencePolicy.DecideTest (pure, unit-
            // tested) for the actual decision — usingStoredNotifyreKey
            // below is also what gates whether a successful probe is
            // safe to persist (see ShouldPersistDiscoveredAuthMode
            // further down: reviewer fix, 2026-09-28).
            var typedToken = FaxApiTokenNormalizer.Normalize(ApiToken);
            var usingStoredNotifyreKey = false;
            string notifyreTokenToTest;
            if (SelectedProvider == FaxProvider.Notifyre)
            {
                var testDecision = NotifyreKeyPersistencePolicy.DecideTest(typedToken, _storedNotifyreApiToken);
                if (!testDecision.CanTest)
                {
                    ErrorMessage = testDecision.ErrorMessage;
                    return;
                }
                notifyreTokenToTest = testDecision.TokenToTest;
                usingStoredNotifyreKey = testDecision.UsingStoredKey;
            }
            else
            {
                notifyreTokenToTest = typedToken;
            }

            // Uses the dropdown's CURRENT selection, not the last-saved
            // _settings.Fax.Provider — otherwise switching the dropdown
            // and clicking Test connection before Save would silently
            // test the wrong vendor.
            var credentials = new FaxCredentials { AccessId = AccessId.Trim(), AccessPassword = AccessPassword, ApiToken = notifyreTokenToTest };
            var client = FaxClientFactory.Create(SelectedProvider, _httpClient, credentials);
            var result = await client.TestConnectionAsync();

            // result.Summary already starts with "Connected. " (see
            // NotifyreFaxClient/SrFaxClient's own TestConnectionAsync) —
            // prepending it again here used to show "Connected.
            // Connected. ..." in the dialog. For Notifyre, also say
            // which key it used (Will's brief item 3).
            var keySourceSuffix = SelectedProvider == FaxProvider.Notifyre
                ? (usingStoredNotifyreKey
                    ? " Connected using the saved key."
                    : " Connected using the key in the box (not saved yet — press Save).")
                : "";
            StatusMessage = result.Success ? result.Summary + keySourceSuffix : null;
            ErrorMessage = result.Success ? null : result.ErrorMessage ?? "Couldn't connect.";

            // V-T53 401 follow-up (Will, 2026-09-25): NotifyreFaxClient's
            // probe mutates THIS SAME credentials object's
            // NotifyreAuthMode the moment it finds a non-documented form
            // that works (see NotifyreFaxClient.ProbeAlternateAuthFormsAsync).
            //
            // Reviewer fix (2026-09-28, blocking): this must NEVER persist
            // the BOX value — a probe succeeding while testing an unsaved/
            // candidate token used to silently overwrite the real stored
            // key and swap the live orchestrator client with no Save
            // click, contradicting this method's own "not saved yet —
            // press Save" status line. When testing the STORED key, the
            // token on disk is unchanged either way, so it's safe to
            // re-persist the discovered auth mode right away (merged onto
            // whatever else is already on disk) so a real send picks it
            // up on the app's next run without an extra Save. When
            // testing the BOX (unsaved) value, only remember the
            // discovered mode IN MEMORY — the next real Save (which
            // already writes _notifyreAuthMode) is what persists it, at
            // the same moment it persists the token itself.
            if (result.Success && SelectedProvider == FaxProvider.Notifyre && credentials.NotifyreAuthMode != _notifyreAuthMode)
            {
                _notifyreAuthMode = credentials.NotifyreAuthMode;

                if (NotifyreKeyPersistencePolicy.ShouldPersistDiscoveredAuthMode(usingStoredNotifyreKey))
                {
                    var stored = _credentialStore.Load() ?? new FaxCredentials();
                    stored.ApiToken = credentials.ApiToken;
                    stored.NotifyreAuthMode = credentials.NotifyreAuthMode;
                    stored.NotifyreTokenSavedAtUtc = DateTime.UtcNow;
                    _credentialStore.Save(stored);
                    _storedNotifyreApiToken = credentials.ApiToken;
                    _storedNotifyreTokenSavedAtUtc = stored.NotifyreTokenSavedAtUtc;
                    OnPropertyChanged(nameof(NotifyreKeyStatusText));
                    OnPropertyChanged(nameof(HasStoredNotifyreKey));
                    CredentialsSaved?.Invoke();
                }
                // else: box/unsaved value — nothing written to disk,
                // nothing rebuilt live. _notifyreAuthMode above still
                // carries the discovered mode into the next Save.
            }
        }
        catch (Exception ex)
        {
            ErrorMessage = $"Couldn't connect: {ex.Message}";
        }
        finally
        {
            IsBusy = false;
        }
    }

    private FaxColumnMap BuildColumnMap()
    {
        string Header(string field) => ColumnMap.FirstOrDefault(r => r.Field == field)?.Header ?? "";
        string? OptionalHeader(string field)
        {
            var value = Header(field);
            return string.IsNullOrWhiteSpace(value) ? null : value;
        }

        return new FaxColumnMap
        {
            PatientFullNameHeader = OptionalHeader("Patient full name (Last, First)"),
            PatientFirstNameHeader = Header("Patient first name"),
            PatientLastNameHeader = Header("Patient last name"),
            VaccineNameHeader = Header("Vaccine name"),
            AdministeredDateHeader = Header("Administered date"),
            DobHeader = Header("DOB"),
            LotHeader = OptionalHeader("Lot"),
            ManufacturerHeader = OptionalHeader("Manufacturer"),
            DoseHeader = OptionalHeader("Dose"),
            RouteHeader = OptionalHeader("Route"),
            SiteHeader = OptionalHeader("Site"),
            PharmacistHeader = OptionalHeader("Administering pharmacist"),
            PrescriberNameHeader = OptionalHeader("Prescriber name"),
            PrescriberNpiHeader = OptionalHeader("Prescriber NPI"),
            PrescriberFaxHeader = OptionalHeader("Prescriber fax"),
            VisDateHeader = OptionalHeader("VIS date"),
        };
    }
}
