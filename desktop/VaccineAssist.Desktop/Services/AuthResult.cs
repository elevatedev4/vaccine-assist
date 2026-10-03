namespace VaccineAssist.Desktop.Services;

public sealed class AuthResult
{
    public bool Success { get; private init; }
    public string? ErrorMessage { get; private init; }

    /// <summary>
    /// True only for a failure that says NOTHING about the credential —
    /// the network was down, timed out, or Supabase answered 5xx/429. A
    /// transient failure must never clear a stored session or be shown as
    /// "sign in again": the saved sign-in is still good, the service just
    /// couldn't be reached right now.
    /// </summary>
    public bool IsTransient { get; private init; }

    public static AuthResult Ok() => new() { Success = true };
    public static AuthResult Fail(string message) => new() { Success = false, ErrorMessage = message };
    public static AuthResult TransientFail(string message) => new() { Success = false, ErrorMessage = message, IsTransient = true };
}
