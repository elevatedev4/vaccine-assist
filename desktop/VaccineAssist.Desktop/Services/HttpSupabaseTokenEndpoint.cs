using System;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using VaccineAssist.Desktop.Settings;

namespace VaccineAssist.Desktop.Services;

/// <summary>
/// Raw-HTTP implementation of ISupabaseTokenEndpoint against Supabase
/// Auth (GoTrue). Classifies every outcome as Success / Rejected /
/// Transient from the HTTP status alone so a flaky network can never be
/// mistaken for a revoked session (which would delete the stored
/// credential and force a manual sign-in). Never logs or returns token
/// values.
/// </summary>
public sealed class HttpSupabaseTokenEndpoint : ISupabaseTokenEndpoint
{
    /// <summary>Per-request cap — a hung connection becomes Transient
    /// instead of blocking startup/refresh forever.</summary>
    public static readonly TimeSpan DefaultRequestTimeout = TimeSpan.FromSeconds(8);

    private readonly HttpClient _httpClient;
    private readonly AppSettings _settings;
    private readonly TimeSpan _requestTimeout;

    public HttpSupabaseTokenEndpoint(HttpClient httpClient, AppSettings settings, TimeSpan? requestTimeout = null)
    {
        _httpClient = httpClient;
        _settings = settings;
        _requestTimeout = requestTimeout ?? DefaultRequestTimeout;
    }

    public async Task<TokenRefreshResult> RefreshAsync(string refreshToken, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(_settings.SupabaseUrl) || string.IsNullOrWhiteSpace(_settings.SupabaseAnonKey))
        {
            return TokenRefreshResult.Transient("Supabase is not configured");
        }

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(_requestTimeout);

        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, BuildUrl("/auth/v1/token?grant_type=refresh_token"));
            request.Headers.TryAddWithoutValidation("apikey", _settings.SupabaseAnonKey);
            request.Content = new StringContent(
                JsonSerializer.Serialize(new { refresh_token = refreshToken }),
                Encoding.UTF8,
                "application/json");

            using var response = await _httpClient.SendAsync(request, timeout.Token).ConfigureAwait(false);
            var body = await response.Content.ReadAsStringAsync(timeout.Token).ConfigureAwait(false);

            if (response.IsSuccessStatusCode)
            {
                return ParseSuccess(body);
            }

            return Classify(response.StatusCode, body);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return TokenRefreshResult.Transient($"timed out after {_requestTimeout.TotalSeconds:0}s");
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (HttpRequestException ex)
        {
            return TokenRefreshResult.Transient($"network error ({ex.GetType().Name})");
        }
        catch (Exception ex)
        {
            // Anything unexpected is NOT proof the token is bad — keep it.
            return TokenRefreshResult.Transient($"unexpected error ({ex.GetType().Name})");
        }
    }

    public async Task LogoutLocalAsync(string accessToken, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(_settings.SupabaseUrl) || string.IsNullOrWhiteSpace(_settings.SupabaseAnonKey))
        {
            return;
        }

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(_requestTimeout);

        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, BuildUrl("/auth/v1/logout?scope=local"));
            request.Headers.TryAddWithoutValidation("apikey", _settings.SupabaseAnonKey);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
            using var response = await _httpClient.SendAsync(request, timeout.Token).ConfigureAwait(false);
        }
        catch (Exception)
        {
            // Best effort — local state is already cleared by the caller.
        }
    }

    private string BuildUrl(string pathAndQuery) => _settings.SupabaseUrl.TrimEnd('/') + pathAndQuery;

    private static TokenRefreshResult ParseSuccess(string body)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            var accessToken = root.TryGetProperty("access_token", out var at) ? at.GetString() : null;
            var refreshToken = root.TryGetProperty("refresh_token", out var rt) ? rt.GetString() : null;
            if (!string.IsNullOrEmpty(accessToken) && !string.IsNullOrEmpty(refreshToken))
            {
                return TokenRefreshResult.Success(accessToken, refreshToken);
            }
        }
        catch (JsonException)
        {
            // fall through
        }

        // A 200 that doesn't carry a token pair is a server/proxy oddity,
        // not a verdict on the refresh token.
        return TokenRefreshResult.Transient("200 response without a token pair");
    }

    /// <summary>
    /// GoTrue answers a dead refresh token with 400 (invalid_grant /
    /// refresh_token_not_found / refresh_token_already_used / session_not_found),
    /// occasionally 401/403 (banned/forbidden user) or 404/422. Rate limits
    /// (429), request timeouts (408) and every 5xx are server-side
    /// hiccups and must be retried, never treated as a revoked session.
    /// </summary>
    private static TokenRefreshResult Classify(HttpStatusCode status, string body)
    {
        var code = (int)status;
        var detail = $"HTTP {code}{ExtractErrorCode(body)}";

        if (code == 408 || code == 429 || code >= 500)
        {
            return TokenRefreshResult.Transient(detail);
        }

        if (code == 400 || code == 401 || code == 403 || code == 404 || code == 422)
        {
            return TokenRefreshResult.Rejected(detail);
        }

        return TokenRefreshResult.Transient(detail);
    }

    private static string ExtractErrorCode(string body)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            foreach (var name in new[] { "error_code", "error" })
            {
                if (doc.RootElement.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String)
                {
                    var text = value.GetString();
                    if (!string.IsNullOrWhiteSpace(text) && text.Length <= 64)
                    {
                        return $" ({text})";
                    }
                }
            }
        }
        catch (Exception)
        {
            // Not JSON — status alone is enough.
        }

        return "";
    }
}
