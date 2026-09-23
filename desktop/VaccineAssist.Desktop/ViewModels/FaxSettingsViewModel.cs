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
/// validates fax numbers (digits, 10-11)."
/// </summary>
public sealed class FaxSettingsViewModel : ObservableObject
{
    private readonly AppSettings _settings;
    private readonly ILocalSettingsService _localSettingsService;
    private readonly IFaxCredentialStore _credentialStore;
    private readonly IPrescriberDirectory _prescriberDirectory;
    private readonly HttpClient _httpClient;

    private string _accessId = "";
    private string _accessPassword = "";
    private string _senderEmail = "";
    private string _pharmacyName = "";
    private string _pharmacyPhone = "";
    private string _pharmacyFax = "";
    private string _accountCode = "";
    private string _inputFolder = "";
    private string _dailyRunTime = "18:30";
    private bool _dailyRunEnabled = true;
    private bool _isBusy;
    private string? _statusMessage;
    private string? _errorMessage;

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

        LoadFromCurrentState();
    }

    public ObservableCollection<FaxColumnMapRow> ColumnMap { get; } = new();
    public ObservableCollection<PrescriberRow> Prescribers { get; } = new();

    public string AccessId { get => _accessId; set => SetProperty(ref _accessId, value); }
    public string AccessPassword { get => _accessPassword; set => SetProperty(ref _accessPassword, value); }
    public string SenderEmail { get => _senderEmail; set => SetProperty(ref _senderEmail, value); }
    public string PharmacyName { get => _pharmacyName; set => SetProperty(ref _pharmacyName, value); }
    public string PharmacyPhone { get => _pharmacyPhone; set => SetProperty(ref _pharmacyPhone, value); }
    public string PharmacyFax { get => _pharmacyFax; set => SetProperty(ref _pharmacyFax, value); }
    public string AccountCode { get => _accountCode; set => SetProperty(ref _accountCode, value); }
    public string InputFolder { get => _inputFolder; set => SetProperty(ref _inputFolder, value); }
    public string DailyRunTime { get => _dailyRunTime; set => SetProperty(ref _dailyRunTime, value); }
    public bool DailyRunEnabled { get => _dailyRunEnabled; set => SetProperty(ref _dailyRunEnabled, value); }

    public bool IsBusy { get => _isBusy; private set => SetProperty(ref _isBusy, value); }
    public string? StatusMessage { get => _statusMessage; private set => SetProperty(ref _statusMessage, value); }
    public string? ErrorMessage { get => _errorMessage; private set => SetProperty(ref _errorMessage, value); }

    public ICommand SaveCommand { get; }
    public ICommand TestConnectionCommand { get; }
    public ICommand AddPrescriberCommand { get; }
    public ICommand DeletePrescriberCommand { get; }

    /// <summary>Set by the code-behind's folder-browse dialog (a WPF/
    /// Win32 concern that doesn't belong in this ViewModel) — see
    /// FaxSettingsWindow.xaml.cs's Browse button handler.</summary>
    public void SetInputFolder(string folder) => InputFolder = folder;

    private void LoadFromCurrentState()
    {
        var fax = _settings.Fax;
        SenderEmail = fax.SenderEmail;
        PharmacyName = fax.PharmacyName;
        PharmacyPhone = fax.PharmacyPhone;
        PharmacyFax = fax.PharmacyFax;
        AccountCode = fax.AccountCode ?? "";
        InputFolder = fax.InputFolder;
        DailyRunTime = fax.DailyRunTime;
        DailyRunEnabled = fax.DailyRunEnabled;

        var credentials = _credentialStore.Load();
        AccessId = credentials?.AccessId ?? "";
        AccessPassword = credentials?.AccessPassword ?? "";

        ColumnMap.Clear();
        var map = fax.ColumnMap;
        ColumnMap.Add(new FaxColumnMapRow { Field = "Patient first name", Required = true, Header = map.PatientFirstNameHeader });
        ColumnMap.Add(new FaxColumnMapRow { Field = "Patient last name", Required = true, Header = map.PatientLastNameHeader });
        ColumnMap.Add(new FaxColumnMapRow { Field = "Vaccine name", Required = true, Header = map.VaccineNameHeader });
        ColumnMap.Add(new FaxColumnMapRow { Field = "Administered date", Required = true, Header = map.AdministeredDateHeader });
        ColumnMap.Add(new FaxColumnMapRow { Field = "DOB", Header = map.DobHeader ?? "" });
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

            foreach (var row in Prescribers)
            {
                if (!string.IsNullOrWhiteSpace(row.FaxNumber) && !FaxNumberNormalizer.IsValid(row.FaxNumber))
                {
                    ErrorMessage = $"Fax number for \"{row.Name}\" must be 10 or 11 digits.";
                    return;
                }
            }

            var fax = _settings.Fax;
            fax.SenderEmail = SenderEmail.Trim();
            fax.PharmacyName = PharmacyName.Trim();
            fax.PharmacyPhone = PharmacyPhone.Trim();
            fax.PharmacyFax = PharmacyFax.Trim();
            fax.AccountCode = string.IsNullOrWhiteSpace(AccountCode) ? null : AccountCode.Trim();
            fax.InputFolder = InputFolder.Trim();
            fax.DailyRunTime = DailyRunTime.Trim();
            fax.DailyRunEnabled = DailyRunEnabled;
            fax.ColumnMap = BuildColumnMap();

            _localSettingsService.Save(_settings);

            _credentialStore.Save(new FaxCredentials { AccessId = AccessId.Trim(), AccessPassword = AccessPassword });

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

    private async Task TestConnectionAsync()
    {
        IsBusy = true;
        ErrorMessage = null;
        StatusMessage = null;
        try
        {
            var credentials = new FaxCredentials { AccessId = AccessId.Trim(), AccessPassword = AccessPassword };
            var client = FaxClientFactory.Create(_settings.Fax.Provider, _httpClient, credentials);
            var result = await client.TestConnectionAsync();

            StatusMessage = result.Success ? $"Connected. {result.Summary}" : null;
            ErrorMessage = result.Success ? null : result.ErrorMessage ?? "Couldn't connect.";
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
            PatientFirstNameHeader = Header("Patient first name"),
            PatientLastNameHeader = Header("Patient last name"),
            VaccineNameHeader = Header("Vaccine name"),
            AdministeredDateHeader = Header("Administered date"),
            DobHeader = OptionalHeader("DOB"),
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
