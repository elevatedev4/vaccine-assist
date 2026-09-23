namespace VaccineAssist.Desktop.Fax;

public interface IFaxLedger
{
    List<FaxLedgerEntry> Load();

    void Save(List<FaxLedgerEntry> entries);
}
