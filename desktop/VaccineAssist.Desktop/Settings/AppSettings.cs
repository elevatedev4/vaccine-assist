namespace VaccineAssist.Desktop.Settings;

/// <summary>
/// Local, per-workstation configuration — never committed, never
/// synced. Lives at %AppData%\VaccineAssist\settings.json (see
/// LocalSettingsService). Phase 1: the Supabase project doesn't exist
/// yet, so these are expected to be blank/placeholder on a fresh
/// checkout; the Login screen surfaces a clear message rather than
/// crashing when they're unset (see Services/SupabaseAuthService.cs).
/// </summary>
public sealed class AppSettings
{
    /// <summary>Base URL of the cloud app's REST API, e.g. https://vaccine-assist.vercel.app</summary>
    public string CloudApiBaseUrl { get; set; } = "";

    /// <summary>Supabase project URL, e.g. https://xxxxxxxxxxxx.supabase.co</summary>
    public string SupabaseUrl { get; set; } = "";

    /// <summary>Supabase anon (public) key — same value cloud/.env.example calls SUPABASE_ANON_KEY.</summary>
    public string SupabaseAnonKey { get; set; } = "";

    /// <summary>Pre-fills the Login screen's email field; never stores a password.</summary>
    public string? LastSignedInEmail { get; set; }
}
