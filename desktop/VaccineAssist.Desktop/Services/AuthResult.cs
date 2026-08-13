namespace VaccineAssist.Desktop.Services;

public sealed class AuthResult
{
    public bool Success { get; private init; }
    public string? ErrorMessage { get; private init; }

    public static AuthResult Ok() => new() { Success = true };
    public static AuthResult Fail(string message) => new() { Success = false, ErrorMessage = message };
}
