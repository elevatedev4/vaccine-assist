using VaccineAssist.Desktop.Common;

namespace VaccineAssist.Desktop.ViewModels;

/// <summary>One row of the Fax settings window's prescriber-fax-number
/// grid — mirrors Fax/PrescriberDirectoryEntry, but mutable/observable
/// for two-way DataGrid binding.</summary>
public sealed class PrescriberRow : ObservableObject
{
    private string _name = "";
    private string _npi = "";
    private string _faxNumber = "";

    public string Name
    {
        get => _name;
        set => SetProperty(ref _name, value);
    }

    public string Npi
    {
        get => _npi;
        set => SetProperty(ref _npi, value);
    }

    public string FaxNumber
    {
        get => _faxNumber;
        set => SetProperty(ref _faxNumber, value);
    }
}
