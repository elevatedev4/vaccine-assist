namespace VaccineAssist.Desktop.Fax;

/// <summary>
/// Pure decision logic for FaxSettingsViewModel's Notifyre-key-visibility
/// behavior (Will, 2026-09-28), factored out so it's directly unit-
/// testable without FaxSettingsViewModel's WPF-adjacent dependencies
/// (ICommand/AsyncRelayCommand need the WindowsBase/WindowsDesktop
/// runtime, which can't execute on macOS — see FaxKeyStatus's own doc
/// comment for the same reasoning). FaxSettingsViewModel calls INTO this
/// class rather than duplicating the logic, so what's tested here is the
/// actual behavior, not a parallel reimplementation.
///
/// Reviewer fix (2026-09-28, blocking): the original inline logic let
/// "Test connection" with an UNSAVED box value silently persist that
/// token to disk (and swap the live sending client) whenever Notifyre's
/// auth-mode probe found a non-default header form — contradicting the
/// method's own "not saved yet — press Save" status line. The methods
/// below make that distinction an explicit, testable decision instead of
/// an inline conditional buried in an async method.
/// </summary>
public static class NotifyreKeyPersistencePolicy
{
    /// <summary>SaveAsync's "what do we actually persist" decision. A
    /// blank typed box means "keep whatever's already stored" (never
    /// erase a saved key just because Will re-saved an unrelated field);
    /// a non-blank typed box always replaces it. Only errors when NEITHER
    /// the box nor the store has anything.</summary>
    public readonly record struct SaveDecision(bool CanSave, string? ErrorMessage, string TokenToPersist, bool TokenChanged);

    public static SaveDecision DecideSave(string normalizedTypedToken, string storedToken)
    {
        var tokenChanged = !string.IsNullOrWhiteSpace(normalizedTypedToken);
        var tokenToPersist = tokenChanged ? normalizedTypedToken : storedToken;

        return string.IsNullOrWhiteSpace(tokenToPersist)
            ? new SaveDecision(false, "Enter a Notifyre API token.", "", false)
            : new SaveDecision(true, null, tokenToPersist, tokenChanged);
    }

    /// <summary>TestConnectionAsync's "which token do we actually test"
    /// decision — the box when something's typed, otherwise the stored
    /// key, otherwise an error (there's nothing to test at all).
    /// UsingStoredKey is the flag both the on-screen "Connected using
    /// ..." message AND ShouldPersistDiscoveredAuthMode below key off
    /// of.</summary>
    public readonly record struct TestDecision(bool CanTest, string? ErrorMessage, string TokenToTest, bool UsingStoredKey);

    public static TestDecision DecideTest(string normalizedTypedToken, string storedToken)
    {
        if (!string.IsNullOrWhiteSpace(normalizedTypedToken))
        {
            return new TestDecision(true, null, normalizedTypedToken, UsingStoredKey: false);
        }
        if (!string.IsNullOrWhiteSpace(storedToken))
        {
            return new TestDecision(true, null, storedToken, UsingStoredKey: true);
        }
        return new TestDecision(false, "Enter a Notifyre API token to test.", "", UsingStoredKey: false);
    }

    /// <summary>Whether a successful Test connection that discovered a
    /// non-default Notifyre auth mode is safe to persist right away
    /// (merged onto the credential store) — ONLY when the token that was
    /// actually tested IS the one already on disk. When testing an
    /// unsaved BOX value, the discovered mode must stay in memory only;
    /// the next real Save (which already writes the in-memory auth mode
    /// alongside whatever token it persists) is what commits it — never
    /// this probe, and never onto a token Will hasn't confirmed with
    /// Save.</summary>
    public static bool ShouldPersistDiscoveredAuthMode(bool usingStoredKey) => usingStoredKey;

    /// <summary>ForgetKeyAsync's write — blanks ONLY the Notifyre token
    /// and its saved-at timestamp on whatever FaxCredentials is passed
    /// in; every other field (SRFax access id/password, auth mode) is
    /// left exactly as it was.</summary>
    public static FaxCredentials ApplyForget(FaxCredentials current)
    {
        current.ApiToken = "";
        current.NotifyreTokenSavedAtUtc = null;
        return current;
    }
}
