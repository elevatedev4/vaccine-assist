namespace VaccineAssist.Desktop.Settings;

public interface ILocalSettingsService
{
    AppSettings Load();
    void Save(AppSettings settings);
}
