using VaccineAssist.Desktop.Common;

namespace VaccineAssist.Desktop.ViewModels;

/// <summary>One row of the Fax settings window's column-map editor grid —
/// Field is fixed/display-only, Header is the editable text a pharmacist
/// types the report's actual column header into.</summary>
public sealed class FaxColumnMapRow : ObservableObject
{
    private string _header = "";

    public required string Field { get; init; }
    public bool Required { get; init; }

    public string Header
    {
        get => _header;
        set => SetProperty(ref _header, value);
    }
}
