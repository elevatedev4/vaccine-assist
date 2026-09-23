namespace VaccineAssist.Desktop.Fax;

public interface IFaxCredentialStore
{
    /// <summary>Null when nothing is stored, or the file is missing/
    /// corrupt/undecryptable — never throws (matches ISessionStore's
    /// tolerant-by-design posture).</summary>
    FaxCredentials? Load();

    void Save(FaxCredentials credentials);

    void Delete();
}
