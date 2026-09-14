namespace VaccineAssist.Desktop.Settings;

/// <summary>
/// Reads/writes the 90-day persisted-session file
/// (%LocalAppData%\VaccineAssist\session.json) — see SessionStore for the
/// real, DPAPI-backed implementation and PersistedSession for the shape.
/// Mirrors IAutoLoginConfigService/ILocalSettingsService's shape so
/// LoginViewModel can be unit tested against a hand-rolled fake, same as
/// its other two file-backed dependencies.
/// </summary>
public interface ISessionStore
{
    /// <summary>Null when no session is stored, or the file is missing/
    /// corrupt/unreadable/undecryptable (e.g. copied to a different
    /// machine or user profile) — tolerant by design, never throws.</summary>
    PersistedSession? Load();

    void Save(PersistedSession session);

    /// <summary>Removes the persisted session, if any. Called on sign-out —
    /// signing out must not leave a 90-day credential behind that would
    /// silently sign the next person back in.</summary>
    void Delete();
}
