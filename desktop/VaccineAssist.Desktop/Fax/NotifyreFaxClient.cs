using System.Net.Http;
using System.Text;
using System.Text.Json;

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

    public async Task<FaxQueueResult> QueueAsync(FaxRequest request, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(_credentials.ApiToken))
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
        if (string.IsNullOrWhiteSpace(_credentials.ApiToken))
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

    public async Task<FaxAccountInfo> TestConnectionAsync(CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(_credentials.ApiToken))
        {
            return new FaxAccountInfo(false, null, "Enter a Notifyre API token first.");
        }

        string body;
        try
        {
            body = await SendWithRetryAsync(() => BuildRequest(HttpMethod.Get, "/fax/numbers", null), ct);
        }
        catch (Exception ex)
        {
            return new FaxAccountInfo(false, null, $"Couldn't reach Notifyre: {ex.Message}");
        }

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
            var summary = count == 0
                ? "Connected. No fax numbers on this account (fine for outbound-only sending)."
                : $"Connected. {count} fax number(s) on this account.";
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

                if ((int)response.StatusCode < 500)
                {
                    // Non-transient (bad request/auth/etc.) — never retried.
                    throw new HttpRequestException($"Notifyre HTTP error {(int)response.StatusCode}");
                }

                transientError = new HttpRequestException($"Notifyre HTTP error {(int)response.StatusCode}");
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

    private HttpRequestMessage BuildRequest(HttpMethod method, string pathAndQuery, object? jsonBody)
    {
        var request = new HttpRequestMessage(method, BaseUrl + pathAndQuery);
        request.Headers.TryAddWithoutValidation("x-api-token", _credentials.ApiToken);
        if (jsonBody is not null)
        {
            request.Content = new StringContent(JsonSerializer.Serialize(jsonBody), Encoding.UTF8, "application/json");
        }

        return request;
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
