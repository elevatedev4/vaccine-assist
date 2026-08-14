namespace VaccineAssist.Desktop.Settings;

public interface IAutoLoginConfigService
{
    /// <summary>Returns the seeded auto-login config, or null when none
    /// has been seeded (or the file is missing/corrupt) — treated the
    /// same as "no auto-login configured" either way.</summary>
    AutoLoginConfig? Load();
}
