using System.Collections.ObjectModel;
using System.Net.Http;
using System.Windows.Input;
using VaccineAssist.Desktop.Common;
using VaccineAssist.Desktop.Fax;
using VaccineAssist.Desktop.Settings;

namespace VaccineAssist.Desktop.ViewModels;

/// <summary>
/// Backs Views/FaxSettingsWindow.xaml — Will's brief: "SRFax access id /
/// password (password box; saved via DPAPI store; 'Test connection' calls
/// Get_FaxUsage), sender email, pharmacy name/phone/fax (caller id), input
/// folder (browse), run time, enable/disable daily run, column map editor
/// (simple key -> header grid), prescriber fax table grid. Saving
/// validates fax numbers (digits, 10-11)." Extended for Notifyre (Will's
/// pick): a Provider dropdown selects SRFax or Notifyre, each with its own
/// credential field(s) shown/hidden via IsSrFaxSelected/IsNotifyreSelected
/// — see FaxSettingsWindow.xaml's Visibility bindings.
/// </summary>
public sealed class FaxSettingsViewModel : ObservableObject
{
    private readonly AppSettings _settings;
    private readonly ILocalSettingsService _localSettingsService;
    private readonly IFaxCredentialStore _credentialStore;
    private readonly IPrescriberDirectory _prescriberDirectory;
    private readonly HttpClient _httpClient;

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
    private string _inputFolder = "";
    private string _dailyRunTime = "18:30";
    private bool _dailyRunEnabled = true;
    private bool _isBusy;
    private string? _statusMessage;
    private string? _errorMessage;

    /// <summary>The Notifyre token actually on disk right now (from
    /// FaxCredentialStore) — kept separate from the bindable ApiToken
    /// property, which is ONLY ever "whatever's typed in the box THIS
    /// session" (starts blank even when a key IS stored — Notifyre-key-
    /// visibility follow-up, Will 2026-09-28: "leave the token box empty
    /// ... never display the full token"). SaveAsync falls back to this
    /// when the box is left blank, so re-saving unrelated fields (e.g.
    /// pharmacy phone) can never accidentally blank out an already-saved
    /// key.</summary>
    private string _storedNotifyreApiToken = "";
    private DateTime? _storedNotifyreTokenSavedAtUtc;

    /// <summary>Which header form Notifyre last proved it accepts this
    /// token in — loaded from the credential store on window open,
    /// updated (and immediately re-persisted, see TestConnectionAsync
    /// below) the moment a Test connection probe finds a non-documented
    /// form works, and carried into SaveAsync's credentials write so a
    /// later Save never silently reverts a discovered mode back to the
    /// documented default. See FaxCredentials.NotifyreAuthMode's own doc
    /// comment (V-T53 401 follow-up, 2026-09-25).</summary>
    private NotifyreAuthMode _notifyreAuthMode = NotifyreAuthMode.XApiToken;

    public FaxSettingsViewModel(
        AppSettings settings,
        ILocalSettingsService localSettingsService,
        IFaxCredentialStore credentialStore,
        IPrescriberDirectory prescriberDirectory,
        HttpClient httpClient)
    {
        _settings = settings;
        _localSettingsService = localSettingsService;
        _credentialStore = credentialStore;
        _prescriberDirectory = prescriberDirectory;
        _httpClient = httpClient;

        SaveCommand = new AsyncRelayCommand(SaveAsync, () => !IsBusy);
        TestConnectionCommand = new AsyncRelayCommand(TestConnectionAsync, () => !IsBusy);
        AddPrescriberCommand = new RelayCommand(() => Prescribers.Add(new PrescriberRow()));
        DeletePrescriberCommand = new RelayCommandOfT<PrescriberRow>(row =>
        {
            if (row is not null) Prescribers.Remove(row);
        });
        ForgetKeyCommand = new AsyncRelayCommand(ForgetKeyAsync, () => !IsBusy && HasStoredNotifyreKey);

        LoadFromCurrentState();
    }

    /// <summary>Raised right after SaveAsync (or ForgetKeyAsync)
    /// persists a Notifyre credential/provider change — MainWindow
    /// subscribes to rebuild FaxRunOrchestrator's IFaxClient from the
    /// freshly-stored credentials, so a real send never uses a stale
    /// in-memory token from before this save (see
    /// FaxRunOrchestrator.UpdateFaxClient's own doc comment).</summary>
    public event Action? CredentialsSaved;

    public ObservableCollection<FaxColumnMapRow> ColumnMap { get; } = new();
    public ObservableCollection<PrescriberRow> Prescribers { get; } = new();

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
            }
        }
    }

    /// <summary>Drives Visibility on the SRFax access id/password fields
    /// in FaxSettingsWindow.xaml.</summary>
    public bool IsSrFaxSelected => SelectedProvider == FaxProvider.SrFax;

    /// <summary>Drives Visibility on the Notifyre API token field in
    /// FaxSettingsWindow.xaml.</summary>
    public bool IsNotifyreSelected => SelectedProvider == FaxProvider.Notifyre;

    public string AccessId { get => _accessId; set => SetProperty(ref _accessId, value); }
    public string AccessPassword { get => _accessPassword; set => SetProperty(ref _accessPassword, value); }

    /// <summary>Notifyre's x-api-token value — read from ApiTokenBox in
    /// code-behind on Save/Test connection, same PasswordBox-isn't-
    /// bindable pattern as AccessPassword.</summary>
    public string ApiToken { get => _apiToken; set => SetProperty(ref _apiToken, value); }

    public string SenderEmail { get => _senderEmail; set => SetProperty(ref _senderEmail, value); }
    public string PharmacyName { get => _pharmacyName; set => SetProperty(ref _pharmacyName, value); }
    public string PharmacyPhone { get => _pharmacyPhone; set => SetProperty(ref _pharmacyPhone, value); }
    public string PharmacyFax { get => _pharmacyFax; set => SetProperty(ref _pharmacyFax, value); }
    public string PharmacyAddressLine1 { get => _pharmacyAddressLine1; set => SetProperty(ref _pharmacyAddressLine1, value); }
    public string PharmacyCityStateZip { get => _pharmacyCityStateZip; set => SetProperty(ref _pharmacyCityStateZip, value); }

    /// <summary>Printed under "Sincerely," on the letter — see
    /// FaxSettings.SignatureName's own doc comment for the default.</summary>
    public string SignatureName { get => _signatureName; set => SetProperty(ref _signatureName, value); }

    public string AccountCode { get => _accountCode; set => SetProperty(ref _accountCode, value); }
    public string InputFolder { get => _inputFolder; set => SetProperty(ref _inputFolder, value); }
    public string DailyRunTime { get => _dailyRunTime; set => SetProperty(ref _dailyRunTime, value); }
    public bool DailyRunEnabled { get => _dailyRunEnabled; set => SetProperty(ref _dailyRunEnabled, value); }

    public bool IsBusy { get => _isBusy; private set => SetProperty(ref _isBusy, value); }
    public string? StatusMessage { get => _statusMessage; private set => SetProperty(ref _statusMessage, value); }
    public string? ErrorMessage { get => _errorMessage; private set => SetProperty(ref _errorMessage, value); }

    /// <summary>"No key saved" / "Notifyre key saved (ends …1234, saved
    /// …)" — see FaxKeyStatus.Describe. Bound read-only next to the API
    /// token box; never shows the token itself.</summary>
    public string NotifyreKeyStatusText => FaxKeyStatus.Describe(
        FaxKeyStatus.Last4OfToken(_storedNotifyreApiToken), _storedNotifyreTokenSavedAtUtc);

    /// <summary>Drives the "Forget key" button's enabled state and the
    /// API-token box's "paste a new key to replace" hint text's
    /// visibility.</summary>
    public bool HasStoredNotifyreKey => !string.IsNullOrWhiteSpace(_storedNotifyreApiToken);

    public ICommand SaveCommand { get; }
    public ICommand TestConnectionCommand { get; }
    public ICommand AddPrescriberCommand { get; }
    public ICommand DeletePrescriberCommand { get; }
    public ICommand ForgetKeyCommand { get; }

    /// <summary>Set by the code-behind's folder-browse dialog (a WPF/
    /// Win32 concern that doesn't belong in this ViewModel) — see
    /// FaxSettingsWindow.xaml.cs's Browse button handler.</summary>
    public void SetInputFolder(string folder) => InputFolder = folder;

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
        InputFolder = fax.InputFolder;
        DailyRunTime = fax.DailyRunTime;
        DailyRunEnabled = fax.DailyRunEnabled;

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

        ColumnMap.Clear();
        var map = fax.ColumnMap;
        // Pioneer's report (V-T53 401/column-map follow-up) has ONE
        // combined "Last, First" name column rather than separate first/
        // last columns — this row takes priority when filled in (see
        // FaxColumnMap.PatientFullNameHeader's own doc comment); the two
        // separate-column rows below stay in the grid as a fallback for a
        // workstation whose export uses them instead.
        ColumnMap.Add(new FaxColumnMapRow { Field = "Patient full name (Last, First)", Required = true, Header = map.PatientFullNameHeader ?? "" });
        ColumnMap.Add(new FaxColumnMapRow { Field = "Patient first name", Header = map.PatientFirstNameHeader });
        ColumnMap.Add(new FaxColumnMapRow { Field = "Patient last name", Header = map.PatientLastNameHeader });
        ColumnMap.Add(new FaxColumnMapRow { Field = "Vaccine name", Required = true, Header = map.VaccineNameHeader });
        ColumnMap.Add(new FaxColumnMapRow { Field = "Administered date", Required = true, Header = map.AdministeredDateHeader });
        // REQUIRED (fax-report-layout brief, 2026-09-28) — see
        // FaxColumnMap.DobHeader's own doc comment.
        ColumnMap.Add(new FaxColumnMapRow { Field = "DOB", Required = true, Header = map.DobHeader });
        ColumnMap.Add(new FaxColumnMapRow { Field = "Lot", Header = map.LotHeader ?? "" });
        ColumnMap.Add(new FaxColumnMapRow { Field = "Manufacturer", Header = map.ManufacturerHeader ?? "" });
        ColumnMap.Add(new FaxColumnMapRow { Field = "Dose", Header = map.DoseHeader ?? "" });
        ColumnMap.Add(new FaxColumnMapRow { Field = "Route", Header = map.RouteHeader ?? "" });
        ColumnMap.Add(new FaxColumnMapRow { Field = "Site", Header = map.SiteHeader ?? "" });
        ColumnMap.Add(new FaxColumnMapRow { Field = "Administering pharmacist", Header = map.PharmacistHeader ?? "" });
        ColumnMap.Add(new FaxColumnMapRow { Field = "Prescriber name", Header = map.PrescriberNameHeader ?? "" });
        ColumnMap.Add(new FaxColumnMapRow { Field = "Prescriber NPI", Header = map.PrescriberNpiHeader ?? "" });
        ColumnMap.Add(new FaxColumnMapRow { Field = "Prescriber fax", Header = map.PrescriberFaxHeader ?? "" });
        ColumnMap.Add(new FaxColumnMapRow { Field = "VIS date", Header = map.VisDateHeader ?? "" });

        Prescribers.Clear();
        foreach (var entry in _prescriberDirectory.Load())
        {
            Prescribers.Add(new PrescriberRow { Name = entry.Name, Npi = entry.Npi ?? "", FaxNumber = entry.FaxNumber });
        }
    }

    private async Task SaveAsync()
    {
        IsBusy = true;
        ErrorMessage = null;
        StatusMessage = null;
        try
        {
            // Will's brief: "Saving validates fax numbers (digits, 10-11)."
            // Applies to the pharmacy's own caller-id fax AND every
            // prescriber row with something typed into it (a still-blank
            // row is fine — Will just hasn't filled it in yet).
            if (!string.IsNullOrWhiteSpace(PharmacyFax) && !FaxNumberNormalizer.IsValid(PharmacyFax))
            {
                ErrorMessage = "Pharmacy fax number must be 10 or 11 digits.";
                return;
            }

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

            foreach (var row in Prescribers)
            {
                if (!string.IsNullOrWhiteSpace(row.FaxNumber) && !FaxNumberNormalizer.IsValid(row.FaxNumber))
                {
                    ErrorMessage = $"Fax number for \"{row.Name}\" must be 10 or 11 digits.";
                    return;
                }
            }

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
            fax.InputFolder = InputFolder.Trim();
            fax.DailyRunTime = DailyRunTime.Trim();
            fax.DailyRunEnabled = DailyRunEnabled;
            fax.ColumnMap = BuildColumnMap();

            _localSettingsService.Save(_settings);

            // Carries forward whatever NotifyreAuthMode Test connection
            // last discovered (_notifyreAuthMode) — otherwise Save would
            // silently overwrite a discovered non-documented mode back
            // to the documented default every time Will edits anything
            // else in this window. tokenToPersist is either the newly
            // typed token or (box left blank) whatever was already
            // stored — see its own comment above; NotifyreTokenSavedAtUtc
            // only advances when the token actually changed, so
            // re-saving unrelated fields doesn't make an unchanged key
            // look freshly re-entered.
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

            _prescriberDirectory.Save(Prescribers
                .Where(r => !string.IsNullOrWhiteSpace(r.Name) || !string.IsNullOrWhiteSpace(r.Npi))
                .Select(r => new PrescriberDirectoryEntry
                {
                    Name = r.Name.Trim(),
                    Npi = string.IsNullOrWhiteSpace(r.Npi) ? null : r.Npi.Trim(),
                    FaxNumber = r.FaxNumber.Trim(),
                })
                .ToList());

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
