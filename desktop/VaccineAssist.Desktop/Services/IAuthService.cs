using System.Threading.Tasks;

namespace VaccineAssist.Desktop.Services;

/// <summary>
/// The shared pharmacy login (one Supabase Auth email/password account
/// used by everyone at the pharmacy — no per-staff accounts in phase 1).
/// </summary>
public interface IAuthService
{
    bool IsSignedIn { get; }

    /// <summary>Current Supabase access token, or null when not signed in. Sent
    /// as an Authorization: Bearer header by VaccineApiService.</summary>
    string? AccessToken { get; }

    Task<AuthResult> SignInAsync(string email, string password);

    Task SignOutAsync();
}
