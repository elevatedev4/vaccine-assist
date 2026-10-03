using System.Threading;
using System.Threading.Tasks;

namespace VaccineAssist.Desktop.Services;

public enum TokenRefreshKind
{
    /// <summary>A new access/refresh pair was issued.</summary>
    Success,

    /// <summary>Supabase DEFINITIVELY refused the refresh token (invalid,
    /// already used, revoked, session gone, user banned). Retrying cannot
    /// help — the stored session is dead.</summary>
    Rejected,

    /// <summary>Network failure, timeout, 5xx or rate limit. Says nothing
    /// about the refresh token itself — it must be kept and retried.</summary>
    Transient,
}

public sealed class TokenRefreshResult
{
    private TokenRefreshResult(TokenRefreshKind kind, string? accessToken, string? refreshToken, string? detail)
    {
        Kind = kind;
        AccessToken = accessToken;
        RefreshToken = refreshToken;
        Detail = detail;
    }

    public TokenRefreshKind Kind { get; }
    public string? AccessToken { get; }
    public string? RefreshToken { get; }

    /// <summary>Safe-to-log description (HTTP status / error code) — never
    /// contains a token.</summary>
    public string? Detail { get; }

    public static TokenRefreshResult Success(string accessToken, string refreshToken) =>
        new(TokenRefreshKind.Success, accessToken, refreshToken, null);

    public static TokenRefreshResult Rejected(string detail) => new(TokenRefreshKind.Rejected, null, null, detail);

    public static TokenRefreshResult Transient(string detail) => new(TokenRefreshKind.Transient, null, null, detail);
}

/// <summary>
/// The two raw Supabase Auth (GoTrue) calls the session keeper needs,
/// split out so SessionKeeper's logic is unit-testable without a network.
/// Deliberately NOT the Supabase SDK's client: that client runs its own
/// hidden auto-refresh timer, which rotated the refresh token in memory
/// without ever persisting it (the root cause — see SessionKeeper).
/// </summary>
public interface ISupabaseTokenEndpoint
{
    /// <summary>POST /auth/v1/token?grant_type=refresh_token. Never throws
    /// for network/HTTP failures — those come back as Transient/Rejected.</summary>
    Task<TokenRefreshResult> RefreshAsync(string refreshToken, CancellationToken cancellationToken);

    /// <summary>POST /auth/v1/logout?scope=local — invalidates ONLY this
    /// workstation's session (the SDK's default, "global", signs the
    /// shared pharmacy login out of every workstation). Best effort,
    /// never throws.</summary>
    Task LogoutLocalAsync(string accessToken, CancellationToken cancellationToken);
}
