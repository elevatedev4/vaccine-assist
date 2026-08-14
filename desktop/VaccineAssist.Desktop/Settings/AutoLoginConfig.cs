namespace VaccineAssist.Desktop.Settings;

/// <summary>
/// Per-machine auto-login credentials seeded by the repo root's
/// bootstrap-fresh.ps1 one-liner (via its -Email/-Password parameters) —
/// deliberately kept separate from AppSettings/settings.json (which is
/// not secret: a Supabase anon key and a Cloud API URL, both already
/// designed to be public-safe — see AppSettings.cs). This file only
/// ever contains this one shared pharmacy login and is never committed
/// or synced (see AutoLoginConfigService for the on-disk path).
/// </summary>
public sealed class AutoLoginConfig
{
    public string Email { get; set; } = "";
    public string Password { get; set; } = "";
}
