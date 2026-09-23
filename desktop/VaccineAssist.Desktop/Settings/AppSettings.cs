using VaccineAssist.Desktop.Fax;

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

    /// <summary>
    /// The value auto-selected in PioneerRx's "Priority" pre-entry popup
    /// during guided vaccine data entry (see
    /// PioneerEntryAutomation/Sequencing/Steps/SendF3AndDismissPreEntryDialogsStep.cs) —
    /// Will, 2026-09-13, verbatim: "It's getting stuck because it's missing
    /// the 'Priority' popup that comes up before data entry can begin. It
    /// needs to set the priority to Vaccine when that window comes up."
    /// Exposed here (not hardcoded in the step) so a workstation whose
    /// Priority list uses different wording can be fixed by editing
    /// settings.json, no rebuild required.
    /// </summary>
    public string PriorityValue { get; set; } = "Vaccine";

    /// <summary>
    /// V-T-single-nav Part 3/4 (Will's brief, 2026-09-14): whether the
    /// Pioneer overlay icon (Overlay/PioneerOverlayController.cs) should
    /// attach to PioneerRx at all — the tray menu's "Show Pioneer overlay"
    /// checkbox reads/writes this. Defaults to on, per the brief ("default
    /// on"); persisted here so the choice survives a restart.
    /// </summary>
    public bool ShowPioneerOverlay { get; set; } = true;

    /// <summary>
    /// V-T53 (Will's brief): vaccine -> PCP fax configuration — input
    /// folder, column map, pharmacy identity, run schedule. SRFax
    /// access id/password are NEVER stored here (see
    /// Fax/FaxCredentialStore.cs, DPAPI-protected, a separate file).
    /// </summary>
    public FaxSettings Fax { get; set; } = new();
}
