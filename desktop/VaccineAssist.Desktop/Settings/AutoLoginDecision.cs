namespace VaccineAssist.Desktop.Settings;

/// <summary>
/// Pure decision logic split out of LoginViewModel so it's unit-testable
/// without any WPF/Supabase/IO dependencies — see
/// VaccineAssist.Desktop.Tests/AutoLoginDecisionTests.cs.
/// </summary>
public static class AutoLoginDecision
{
    /// <summary>Whether a loaded AutoLoginConfig (possibly null, e.g. no
    /// config file was ever seeded) is complete enough to attempt a
    /// silent sign-in with.</summary>
    public static bool ShouldAttemptAutoLogin(AutoLoginConfig? config)
    {
        return config is not null
            && !string.IsNullOrWhiteSpace(config.Email)
            && !string.IsNullOrWhiteSpace(config.Password);
    }
}
