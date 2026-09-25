using System.Net.Http;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using VaccineAssist.Desktop.Logging;

namespace VaccineAssist.Desktop.Fax;

/// <summary>
/// Notifyre implementation of IFaxClient — REST API at
/// https://api.notifyre.com, authenticated with an x-api-token header
/// (Fax/FaxCredentials.ApiToken, DPAPI-protected in
/// Fax/FaxCredentialStore.cs, same pattern as SrFaxClient's access id/
/// password). Every Notifyre-specific field/endpoint name (Faxes,
/// Recipients, SendFrom, ClientReference, IsHighQuality, Documents[].
/// Filename/Data, FaxID, FriendlyID, /fax/send, /fax/numbers, ...) lives
/// ONLY in this file — IFaxClient's callers never see any of it, matching
/// SrFaxClient's own doc-comment convention.
///
/// Verified 2026-09-22 against docs.notifyre.com's "Send Fax"/"List Sent
/// Faxes"/"List Fax Numbers" pages (a JS-rendered Angular SPA — a plain
/// HTTP fetch only returns the empty shell, so the shapes below were
/// captured by rendering the page and reading its expanded schema trees +
/// the raw cURL code sample, not typed from memory). Two things the
/// original brief assumed turned out not to match the real API surface:
///
/// 1. There is NO documented "get one sent fax by id" endpoint (no
///    GET /fax/send/{id}) — GET /fax/send is a LIST endpoint only
///    (StatusType/FromDate/ToDate/Sort/Limit/Skip filters, no id filter).
///    GetStatusAsync below lists the most recent faxes (Sort=desc,
///    Limit=100) and matches the id client-side. Good enough for this
///    app's polling cadence (FaxReceiptPoller only checks recently-sent
///    faxes) but will report "not found" for a fax that has aged out of
///    the most-recent-100 window — flagged here for whoever revisits this
///    if that ever turns out to matter.
/// 2. Notifyre documents two different fax-status vocabularies that don't
///    line up: the top-level "Status Codes" reference page lists queued/
///    processing/sending/delivered/receiving/no-answer/busy/failed/
///    cancelled, while the List Sent Faxes StatusType filter AND the
///    per-fax Status field documented next to it (plus the Fax Sent
///    webhook payload) say 'accepted'/'successful'/'in_progress'/
///    'failed'/'queued' — matching this brief's assumption. MapStatus
///    below accepts values from BOTH vocabularies rather than gambling on
///    which one the live API actually returns for this field.
///
/// Response JSON keys have also been observed in the wild as lowerCamelCase
/// ("payload"/"success"/"statusCode") even though the docs' own schema
/// tables and cURL examples show PascalCase ("Payload"/"Success") — so
/// every response DTO below deserializes with PropertyNameCaseInsensitive
/// rather than trusting one casing.
/// </summary>
public sealed class NotifyreFaxClient : IFaxClient
{
    private const string BaseUrl = "https://api.notifyre.com";

    private static readonly JsonSerializerOptions ResponseJsonOptions = new() { PropertyNameCaseInsensitive = true };

    // System.Text.Json's DEFAULT encoder escapes "+" (and other characters
    // that are harmless in plain JSON but unsafe embedded in HTML/JS) as
    // \uXXXX — functionally fine for a REST API (any JSON parser decodes
    // + back to '+'), but makes a captured request body confusing to
    // read/grep and broke a naive substring test. Relaxed here since this
    // JSON is never embedded in a web page — only ever POSTed as a request
    // body.
    private static readonly JsonSerializerOptions RequestJsonOptions = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    private readonly HttpClient _httpClient;
    private readonly FaxCredentials _credentials;
    private readonly int _maxAttempts;
    private readonly Func<int, TimeSpan> _backoffProvider;

    /// <param name="maxAttempts">Total attempts (including the first) —
    /// same "3x" retry policy as SrFaxClient, default 3.</param>
    /// <param name="backoffProvider">attempt (1-based) -> delay before the
    /// NEXT attempt. Injectable so tests can pass TimeSpan.Zero and stay
    /// fast; defaults to a small linear backoff in production.</param>
    public NotifyreFaxClient(HttpClient httpClient, FaxCredentials credentials, int maxAttempts = 3, Func<int, TimeSpan>? backoffProvider = null)
    {
        _httpClient = httpClient;
        _credentials = credentials;
        _maxAttempts = Math.Max(1, maxAttempts);
        _backoffProvider = backoffProvider ?? (attempt => TimeSpan.FromMilliseconds(300 * attempt));
    }

    /// <summary>The token this client will actually send, after the same
    /// paste-artifact cleanup applied on save (V-T53 follow-up) — see
    /// FaxApiTokenNormalizer's own doc comment. Computed fresh from
    /// _credentials.ApiToken on every use rather than cached, so it still
    /// cleans up a token that was SAVED before this normalization
    /// existed (an already-corrupted credentials.json entry) without
    /// requiring Will to re-save it.</summary>
    private string NormalizedApiToken => FaxApiTokenNormalizer.Normalize(_credentials.ApiToken);

    public async Task<FaxQueueResult> QueueAsync(FaxRequest request, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(NormalizedApiToken))
        {
            return new FaxQueueResult(false, null, "Notifyre API token not configured — set it in Fax settings.");
        }

        var toE164 = FaxNumberNormalizer.ToE164OrNull(request.ToFaxNumber);
        if (toE164 is null)
        {
            return new FaxQueueResult(false, null, $"Invalid fax number: {request.ToFaxNumber}");
        }

        var body = new SendFaxRequestBody
        {
            Faxes = new FaxesDto
            {
                Recipients = new List<RecipientDto> { new() { Type = "fax_number", Value = toE164 } },
                SendFrom = "",
                ClientReference = request.FileName,
                Subject = "Vaccine administration record",
                IsHighQuality = true,
                Documents = new List<DocumentDto> { new() { Filename = request.FileName, Data = Convert.ToBase64String(request.PdfBytes) } },
            },
        };

        string responseBody;
        try
        {
            responseBody = await SendWithRetryAsync(() => BuildRequest(HttpMethod.Post, "/fax/send", body), ct);
        }
        catch (Exception ex)
        {
            return new FaxQueueResult(false, null, $"Couldn't reach Notifyre: {ex.Message}");
        }

        return ParseQueueResponse(responseBody);
    }

    public async Task<FaxStatusResult> GetStatusAsync(string faxId, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(NormalizedApiToken))
        {
            return new FaxStatusResult(false, FaxSendStatus.Failed, "Notifyre API token not configured.", null);
        }

        string body;
        try
        {
            body = await SendWithRetryAsync(() => BuildRequest(HttpMethod.Get, "/fax/send?sort=desc&limit=100", null), ct);
        }
        catch (Exception ex)
        {
            return new FaxStatusResult(false, FaxSendStatus.Failed, $"Couldn't reach Notifyre: {ex.Message}", null);
        }

        return ParseStatusResponse(body, faxId);
    }

    /// <summary>Header label used for each NotifyreAuthMode in log lines
    /// and in the Summary/ErrorMessage text shown to Will — kept in one
    /// place so the probe loop, its diagnostic logging, and the
    /// user-facing "which header worked" sentence never drift apart.</summary>
    private static string AuthModeLabel(NotifyreAuthMode mode) => mode switch
    {
        NotifyreAuthMode.Bearer => "Authorization: Bearer <token>",
        NotifyreAuthMode.RawAuthorization => "Authorization: <token> (no scheme)",
        _ => "x-api-token (documented)",
    };

    public async Task<FaxAccountInfo> TestConnectionAsync(CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(NormalizedApiToken))
        {
            return new FaxAccountInfo(false, null, "Enter a Notifyre API token first.");
        }

        // V-T53 401 follow-up (Will, 2026-09-23): a masked fingerprint
        // (never the token itself — see AppFileLog's own NO-secrets rule)
        // so a paste error (wrong token, extra characters, a scheme
        // prefix pasted along with it) is visible in the log even though
        // the token's actual bytes never appear there.
        AppFileLog.Log($"[NotifyreFaxClient] Test connection — token fingerprint {MaskToken(NormalizedApiToken)}");

        const string testConnectionMethod = "GET";
        const string testConnectionPath = "/fax/numbers";
        var testConnectionUrl = BaseUrl + testConnectionPath;

        // Documented form first — docs.notifyre.com/api/authentication
        // says "x-api-token: <token>", base https://api.notifyre.com.
        string body;
        try
        {
            body = await SendWithRetryAsync(() => BuildRequest(HttpMethod.Get, testConnectionPath, null, NotifyreAuthMode.XApiToken), ct);
            LogTestConnectionDiagnostic(testConnectionMethod, testConnectionUrl, NormalizedApiToken, body);
        }
        catch (NotifyreHttpException ex) when (ex.StatusCode == 401)
        {
            // Will's brief: "Make Test connection show the HTTP status +
            // Notifyre's error body text in the dialog and log (not just
            // '401')" — ex.Message already carries both (see
            // NotifyreHttpException below).
            AppFileLog.Log($"[NotifyreFaxClient] Test connection failed — {ex.Message}");
            LogTestConnectionDiagnostic(testConnectionMethod, testConnectionUrl, NormalizedApiToken, ex.Body);

            // V-T53 401 follow-up (Will, 2026-09-25, verbatim: "I know
            // the token is correct. I got it myself... Fix the app."):
            // Notifyre returns the SAME 401 "Access denied" body for a
            // missing token and a garbage one, so a bare 401 on the
            // documented header doesn't by itself prove the token is
            // wrong — it only proves THIS header form didn't work.
            // FaxApiTokenNormalizer already guaranteed the attempt above
            // sent the cleaned token, so re-trying x-api-token again
            // would be redundant; go straight to the other forms
            // docs.notifyre.com's own examples show elsewhere. No other
            // Notifyre endpoint is confirmed cheap+authenticated in this
            // repo's cached docs, so there's no third endpoint to try —
            // only these two alternate header forms, each attempted
            // exactly once, bounded to ~4s apiece so a hung probe can't
            // make Test connection hang.
            return await ProbeAlternateAuthFormsAsync(testConnectionMethod, testConnectionUrl, testConnectionPath, ct);
        }
        catch (NotifyreHttpException ex)
        {
            AppFileLog.Log($"[NotifyreFaxClient] Test connection failed — {ex.Message}");
            LogTestConnectionDiagnostic(testConnectionMethod, testConnectionUrl, NormalizedApiToken, ex.Body);
            return new FaxAccountInfo(false, null, ex.Message);
        }
        catch (Exception ex)
        {
            AppFileLog.Log($"[NotifyreFaxClient] Test connection failed — couldn't reach Notifyre: {ex.Message}");
            return new FaxAccountInfo(false, null, $"Couldn't reach Notifyre: {ex.Message}");
        }

        return ParseAccountInfo(body, NotifyreAuthMode.XApiToken);
    }

    /// <summary>Runs after the documented x-api-token form 401s — tries
    /// each alternate auth form Notifyre's own docs show for OTHER
    /// endpoints, in order, stopping at the first 2xx. Updates
    /// _credentials.NotifyreAuthMode (the SAME object this client was
    /// constructed with) the moment a form succeeds, so every later
    /// QueueAsync/GetStatusAsync call on this client uses it too — see
    /// FaxCredentials.NotifyreAuthMode's own doc comment. Persisting that
    /// choice to disk (so a FUTURE app run also uses it) is
    /// FaxSettingsViewModel's job, not this client's.</summary>
    private async Task<FaxAccountInfo> ProbeAlternateAuthFormsAsync(string method, string url, string path, CancellationToken ct)
    {
        var alternates = new[] { NotifyreAuthMode.Bearer, NotifyreAuthMode.RawAuthorization };

        foreach (var mode in alternates)
        {
            var (success, statusCode, probeBody) = await SendProbeAsync(HttpMethod.Get, path, mode, ct);
            LogProbeDiagnostic(method, url, HeaderNameFor(mode), statusCode, probeBody);

            if (success)
            {
                _credentials.NotifyreAuthMode = mode;
                return ParseAccountInfo(probeBody, mode);
            }
        }

        return new FaxAccountInfo(false, null,
            "Notifyre rejected the token in every form (x-api-token, Bearer, raw). The token itself is not recognized — regenerate it in Notifyre → Settings → Developer → API tokens, check the account is verified/out of test mode, and paste the new one.");
    }

    /// <summary>One bounded, non-retried probe attempt for the given auth
    /// form — unlike SendWithRetryAsync (used for real sends/status
    /// checks/the documented Test connection attempt), a probe never
    /// retries on 5xx/transport error: it's only trying to answer "does
    /// Notifyre accept THIS header form at all," and a single ~4s-capped
    /// attempt per form keeps the whole Test connection call fast even
    /// when every form fails.</summary>
    private async Task<(bool Success, int StatusCode, string Body)> SendProbeAsync(HttpMethod method, string pathAndQuery, NotifyreAuthMode mode, CancellationToken ct)
    {
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(TimeSpan.FromSeconds(4));

        try
        {
            using var response = await _httpClient.SendAsync(BuildRequest(method, pathAndQuery, null, mode), timeoutCts.Token);
            var body = await ReadBodySafeAsync(response, ct);
            return (response.IsSuccessStatusCode, (int)response.StatusCode, body);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            return (false, 0, "(probe timed out)");
        }
        catch (Exception ex)
        {
            return (false, 0, $"(probe couldn't reach Notifyre: {ex.Message})");
        }
    }

    private static string HeaderNameFor(NotifyreAuthMode mode) => mode switch
    {
        NotifyreAuthMode.XApiToken => "x-api-token",
        _ => "Authorization",
    };

    private FaxAccountInfo ParseAccountInfo(string body, NotifyreAuthMode mode)
    {
        try
        {
            var envelope = JsonSerializer.Deserialize<NotifyreEnvelope<NumbersPayload>>(body, ResponseJsonOptions);
            if (envelope is null || !envelope.Success)
            {
                return new FaxAccountInfo(false, null, FirstMessage(envelope) ?? "Notifyre reported failure with no message.");
            }

            var count = envelope.Payload?.Numbers?.Count ?? 0;
            // An empty number list is fine for outbound-only accounts —
            // SendFrom is optional on Send Fax, and /fax/numbers is only
            // used here as a lightweight authenticated call to prove the
            // token works (Will verified his account currently returns
            // {"payload":{"numbers":[]},"success":true,"statusCode":200}).
            var baseSummary = count == 0
                ? "Connected. No fax numbers on this account (fine for outbound-only sending)."
                : $"Connected. {count} fax number(s) on this account.";

            // V-T53 401 follow-up: on the documented form this is the
            // whole message; on a form the probe found instead, say
            // exactly which one so it's obvious in the UI (and in the
            // saved settings) that real sends are now using something
            // other than what docs.notifyre.com documents.
            var summary = mode == NotifyreAuthMode.XApiToken
                ? baseSummary
                : $"{baseSummary} Notifyre only accepted the token as {AuthModeLabel(mode)} — using that for real sends too.";

            return new FaxAccountInfo(true, summary, null);
        }
        catch (Exception ex)
        {
            return new FaxAccountInfo(false, null, $"Couldn't parse Notifyre response: {ex.Message}");
        }
    }

    /// <summary>Sends one request, retrying up to _maxAttempts total
    /// attempts on a transport-level failure (a thrown exception, or an
    /// HTTP 5xx) with _backoffProvider's delay between attempts — same
    /// policy/shape as SrFaxClient.PostWithRetryAsync. An HTTP 4xx (a
    /// request-shape/auth problem, never transient) fails immediately
    /// with no retry. requestFactory is invoked fresh on every attempt
    /// since an HttpRequestMessage can't be sent twice.</summary>
    private async Task<string> SendWithRetryAsync(Func<HttpRequestMessage> requestFactory, CancellationToken ct)
    {
        for (var attempt = 1; attempt <= _maxAttempts; attempt++)
        {
            HttpResponseMessage? response = null;
            Exception? transientError = null;
            try
            {
                response = await _httpClient.SendAsync(requestFactory(), ct);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                transientError = ex;
            }

            if (response is not null)
            {
                if (response.IsSuccessStatusCode)
                {
                    return await response.Content.ReadAsStringAsync(ct);
                }

                var errorBody = await ReadBodySafeAsync(response, ct);
                if ((int)response.StatusCode < 500)
                {
                    // Non-transient (bad request/auth/etc.) — never retried.
                    // Carries Notifyre's own status/body text (Will's brief:
                    // "show the HTTP status + Notifyre's error body text in
                    // the dialog and log, not just '401'") instead of a bare
                    // status-code-only message.
                    throw new NotifyreHttpException((int)response.StatusCode, errorBody);
                }

                transientError = new NotifyreHttpException((int)response.StatusCode, errorBody);
            }

            if (attempt >= _maxAttempts)
            {
                throw transientError ?? new HttpRequestException("Notifyre request failed after retries.");
            }

            await Task.Delay(_backoffProvider(attempt), ct);
        }

        // Unreachable in practice (the loop above always returns or
        // throws) — kept so every path has a return for the compiler.
        throw new HttpRequestException("Notifyre request failed after retries.");
    }

    private static async Task<string> ReadBodySafeAsync(HttpResponseMessage response, CancellationToken ct)
    {
        try
        {
            var text = await response.Content.ReadAsStringAsync(ct);
            return string.IsNullOrWhiteSpace(text) ? "(empty response body)" : text;
        }
        catch
        {
            return "(couldn't read response body)";
        }
    }

    /// <summary>First 4 + last 4 characters + length only — enough to
    /// tell "this is the token I meant to paste" from "the wrong thing
    /// (or an extra character/prefix) snuck in" in a log line, without
    /// ever writing the credential itself (AppFileLog's own NO PHI/
    /// secrets rule).</summary>
    private static string MaskToken(string token)
    {
        var trimmed = token.Trim();
        return trimmed.Length <= 8
            ? $"(len={trimmed.Length})"
            : $"{trimmed[..4]}...{trimmed[^4..]} (len={trimmed.Length})";
    }

    /// <summary>Will's brief (V-T53 follow-up, 2026-09-25): every Test
    /// connection attempt logs enough to tell "we sent the token you
    /// think you pasted" from "we sent something else" without EVER
    /// writing the token itself — method/URL/header NAMES (never
    /// values), the (already-normalized — see NormalizedApiToken) token's
    /// length and first-3/last-2 characters, and Notifyre's raw response
    /// body (truncated), so a byte-identical-401 mystery is diagnosable
    /// from %AppData%\VaccineAssist\logs\app.log alone.</summary>
    private static void LogTestConnectionDiagnostic(string method, string url, string normalizedToken, string responseBody)
    {
        var truncatedBody = responseBody.Length > 1000 ? responseBody[..1000] + "…" : responseBody;
        var tokenEdges = normalizedToken.Length < 5
            ? "(too short to show edges)"
            : $"{normalizedToken[..3]}...{normalizedToken[^2..]}";
        AppFileLog.Log(
            "[NotifyreFaxClient] Test connection diagnostic — " +
            $"method={method} url={url} headers=[x-api-token] " +
            $"tokenLength={normalizedToken.Length} tokenFirst3Last2={tokenEdges} " +
            $"responseBody={truncatedBody}");
    }

    /// <summary>Same purpose as LogTestConnectionDiagnostic but for one
    /// alternate-auth-form probe attempt — method/URL/header NAME only
    /// (never the header VALUE, so the token is never logged, masked or
    /// otherwise, from this path) plus the status code and Notifyre's
    /// response body truncated to 200 chars (a probe's body is only ever
    /// "Access denied" or similar, so 200 chars is ample without the
    /// diagnostic line growing unbounded).</summary>
    private static void LogProbeDiagnostic(string method, string url, string headerName, int statusCode, string responseBody)
    {
        var truncatedBody = responseBody.Length > 200 ? responseBody[..200] + "…" : responseBody;
        AppFileLog.Log(
            "[NotifyreFaxClient] Test connection probe — " +
            $"method={method} url={url} header={headerName} status={statusCode} responseBody={truncatedBody}");
    }

    /// <summary>Builds one Notifyre HTTP request, applying the auth
    /// header for whichever <see cref="NotifyreAuthMode"/> is in
    /// effect.</summary>
    /// <param name="authModeOverride">Force a specific auth header form
    /// for THIS one request (used only by TestConnectionAsync's probe —
    /// it needs to try forms other than whatever is currently stored).
    /// Every other caller (QueueAsync, GetStatusAsync, the documented
    /// Test connection attempt) omits this and gets
    /// _credentials.NotifyreAuthMode — the form last proven to work for
    /// this account, defaulting to the documented x-api-token form for
    /// an account that's never needed probing. See
    /// FaxCredentials.NotifyreAuthMode's own doc comment.</param>
    private HttpRequestMessage BuildRequest(HttpMethod method, string pathAndQuery, object? jsonBody, NotifyreAuthMode? authModeOverride = null)
    {
        var request = new HttpRequestMessage(method, BaseUrl + pathAndQuery);
        ApplyAuthHeader(request, authModeOverride ?? _credentials.NotifyreAuthMode);
        if (jsonBody is not null)
        {
            request.Content = new StringContent(JsonSerializer.Serialize(jsonBody, RequestJsonOptions), Encoding.UTF8, "application/json");
        }

        return request;
    }

    /// <summary>Puts the (already-normalized — see NormalizedApiToken)
    /// token on the request in whichever header form <paramref
    /// name="mode"/> names. TryAddWithoutValidation throughout (not
    /// Headers.Add) for the same reason the original x-api-token-only
    /// code used it: a plain .Trim() only strips whitespace, never a
    /// zero-width/invisible character or stray control character — those
    /// are still valid header bytes (so validated Add would accept them
    /// too), but FaxApiTokenNormalizer already stripped them from
    /// NormalizedApiToken, so this is defense-in-depth, not the reason
    /// TryAddWithoutValidation is used here.</summary>
    private void ApplyAuthHeader(HttpRequestMessage request, NotifyreAuthMode mode)
    {
        switch (mode)
        {
            case NotifyreAuthMode.Bearer:
                request.Headers.TryAddWithoutValidation("Authorization", $"Bearer {NormalizedApiToken}");
                break;
            case NotifyreAuthMode.RawAuthorization:
                request.Headers.TryAddWithoutValidation("Authorization", NormalizedApiToken);
                break;
            default:
                request.Headers.TryAddWithoutValidation("x-api-token", NormalizedApiToken);
                break;
        }
    }

    private static FaxQueueResult ParseQueueResponse(string body)
    {
        try
        {
            var envelope = JsonSerializer.Deserialize<NotifyreEnvelope<SendFaxPayload>>(body, ResponseJsonOptions);
            if (envelope is null || !envelope.Success)
            {
                return new FaxQueueResult(false, null, FirstMessage(envelope) ?? "Notifyre reported failure with no message.");
            }

            var faxId = envelope.Payload?.FaxID;
            return string.IsNullOrWhiteSpace(faxId)
                ? new FaxQueueResult(false, null, "Notifyre reported success with no fax id.")
                : new FaxQueueResult(true, faxId, null);
        }
        catch (Exception ex)
        {
            return new FaxQueueResult(false, null, $"Couldn't parse Notifyre response: {ex.Message}");
        }
    }

    private static FaxStatusResult ParseStatusResponse(string body, string faxId)
    {
        try
        {
            var envelope = JsonSerializer.Deserialize<NotifyreEnvelope<ListFaxesPayload>>(body, ResponseJsonOptions);
            if (envelope is null || !envelope.Success)
            {
                return new FaxStatusResult(false, FaxSendStatus.Failed, FirstMessage(envelope) ?? "Notifyre reported failure with no message.", null);
            }

            var match = envelope.Payload?.Faxes?.FirstOrDefault(f => string.Equals(f.ID, faxId, StringComparison.OrdinalIgnoreCase));
            if (match is null)
            {
                return new FaxStatusResult(false, FaxSendStatus.Failed, $"Fax {faxId} wasn't found in Notifyre's most recent sent faxes.", null);
            }

            var mapped = MapStatus(match.Status);
            if (mapped is null)
            {
                return new FaxStatusResult(false, FaxSendStatus.Failed, $"Unrecognized Notifyre status: {match.Status}", match.Pages);
            }

            var errorMessage = mapped == FaxSendStatus.Failed
                ? (string.IsNullOrWhiteSpace(match.StatusMessage) ? "Notifyre reported the fax as failed." : match.StatusMessage)
                : null;
            return new FaxStatusResult(true, mapped.Value, errorMessage, match.Pages);
        }
        catch (Exception ex)
        {
            return new FaxStatusResult(false, FaxSendStatus.Failed, $"Couldn't parse Notifyre response: {ex.Message}", null);
        }
    }

    /// <summary>Maps every fax-status string documented anywhere on
    /// docs.notifyre.com (see this class's own doc comment on why there
    /// are two overlapping vocabularies) onto IFaxClient's vendor-neutral
    /// FaxSendStatus — null for anything unrecognized, exactly like
    /// SrFaxClient's own status mapping.</summary>
    private static FaxSendStatus? MapStatus(string? raw) => raw?.Trim().ToLowerInvariant() switch
    {
        "queued" => FaxSendStatus.Queued,
        "accepted" => FaxSendStatus.Queued,
        "processing" => FaxSendStatus.InProcess,
        "sending" => FaxSendStatus.InProcess,
        "in_progress" => FaxSendStatus.InProcess,
        "receiving" => FaxSendStatus.InProcess,
        "successful" => FaxSendStatus.Sent,
        "delivered" => FaxSendStatus.Sent,
        "failed" => FaxSendStatus.Failed,
        "no-answer" => FaxSendStatus.Failed,
        "busy" => FaxSendStatus.Failed,
        "cancelled" => FaxSendStatus.Failed,
        _ => null,
    };

    private static string? FirstMessage<T>(NotifyreEnvelope<T>? envelope) where T : class =>
        !string.IsNullOrWhiteSpace(envelope?.Message) ? envelope!.Message : envelope?.Errors?.FirstOrDefault(e => !string.IsNullOrWhiteSpace(e));

    /// <summary>A non-2xx HTTP response from Notifyre, carrying the status
    /// code AND the response body text (truncated) — Will's brief: "Make
    /// Test connection show the HTTP status + Notifyre's error body text
    /// in the dialog and log (not just '401')".</summary>
    private sealed class NotifyreHttpException : Exception
    {
        /// <summary>The RAW (untruncated) response body — kept separately
        /// from Message (which truncates to 500 chars for the user-facing
        /// dialog) so LogTestConnectionDiagnostic can log its own
        /// (differently truncated) copy of the actual body.</summary>
        public string Body { get; }

        /// <summary>The HTTP status code — TestConnectionAsync checks
        /// this specifically for 401 (Notifyre's "credential not
        /// recognized in this form" signal) to decide whether to run the
        /// alternate-auth-form probe; any other 4xx (400/403/etc.) is a
        /// different kind of failure and is surfaced as-is, with no
        /// probe.</summary>
        public int StatusCode { get; }

        public NotifyreHttpException(int statusCode, string body)
            : base($"Notifyre HTTP {statusCode}: {Truncate(body)}")
        {
            StatusCode = statusCode;
            Body = body;
        }

        private static string Truncate(string body) => body.Length > 500 ? body[..500] + "…" : body;
    }

    // ---- Request DTOs — property names match docs.notifyre.com's "Send
    // Fax" cURL example exactly (PascalCase); System.Text.Json serializes
    // C# property names verbatim with no naming policy applied here. ----

    private sealed class SendFaxRequestBody
    {
        public FaxesDto Faxes { get; set; } = new();
    }

    private sealed class FaxesDto
    {
        public List<RecipientDto> Recipients { get; set; } = new();
        public string SendFrom { get; set; } = "";
        public string ClientReference { get; set; } = "";
        public string Subject { get; set; } = "";
        public bool IsHighQuality { get; set; }
        public List<DocumentDto> Documents { get; set; } = new();
    }

    private sealed class RecipientDto
    {
        public string Type { get; set; } = "fax_number";
        public string Value { get; set; } = "";
    }

    private sealed class DocumentDto
    {
        public string Filename { get; set; } = "";
        public string Data { get; set; } = "";
    }

    // ---- Response DTOs — deserialized case-insensitively (see this
    // class's doc comment: live responses have been observed in both
    // PascalCase and lowerCamelCase). ----

    private sealed class NotifyreEnvelope<T> where T : class
    {
        public bool Success { get; set; }
        public string? Message { get; set; }
        public T? Payload { get; set; }
        public List<string>? Errors { get; set; }
    }

    private sealed class SendFaxPayload
    {
        public string? FaxID { get; set; }
        public string? FriendlyID { get; set; }
    }

    private sealed class ListFaxesPayload
    {
        public List<SentFaxItem>? Faxes { get; set; }
        public int Total { get; set; }
    }

    private sealed class SentFaxItem
    {
        public string? ID { get; set; }
        public string? FriendlyID { get; set; }
        public string? Status { get; set; }
        public string? StatusMessage { get; set; }
        public int? Pages { get; set; }
    }

    private sealed class NumbersPayload
    {
        public List<JsonElement>? Numbers { get; set; }
    }
}
