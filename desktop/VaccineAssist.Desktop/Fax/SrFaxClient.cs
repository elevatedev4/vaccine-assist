using System.Net.Http;
using System.Text.Json;

namespace VaccineAssist.Desktop.Fax;

/// <summary>
/// SRFax implementation of IFaxClient — Will's brief: HttpClient POST
/// form-encoded to https://www.srfax.com/SRF_SecWebSvc.php. Every
/// SRFax-specific field/action name (access_id, sCallerID, Queue_Fax,
/// Get_FaxStatus, Get_FaxUsage, SentStatus, ...) lives ONLY in this file —
/// IFaxClient's callers (FaxRunOrchestrator, FaxReceiptPoller, the
/// Settings window) never see any of it, so swapping in a second vendor
/// later (Notifyre/Telnyx — Will is still comparing price) never touches
/// them.
///
/// Retry policy (Will's brief): "Retry transient HTTP errors 3x with
/// backoff; never retry a Failed Queue_Fax automatically (avoid
/// double-sends)." PostWithRetryAsync only retries a TRANSPORT-level
/// failure (a thrown exception, or an HTTP 5xx) — an HTTP 200 whose body
/// says {"Status":"Failed",...} is a normal, successfully-delivered
/// response and is parsed/returned exactly once, never retried, for
/// every action including Queue_Fax.
/// </summary>
public sealed class SrFaxClient : IFaxClient
{
    private const string Endpoint = "https://www.srfax.com/SRF_SecWebSvc.php";

    private readonly HttpClient _httpClient;
    private readonly FaxCredentials _credentials;
    private readonly int _maxAttempts;
    private readonly Func<int, TimeSpan> _backoffProvider;

    /// <param name="maxAttempts">Total attempts (including the first),
    /// per the brief's "3x" — default 3.</param>
    /// <param name="backoffProvider">attempt (1-based) -> delay before the
    /// NEXT attempt. Injectable so tests can pass TimeSpan.Zero and stay
    /// fast; defaults to a small linear backoff in production.</param>
    public SrFaxClient(HttpClient httpClient, FaxCredentials credentials, int maxAttempts = 3, Func<int, TimeSpan>? backoffProvider = null)
    {
        _httpClient = httpClient;
        _credentials = credentials;
        _maxAttempts = Math.Max(1, maxAttempts);
        _backoffProvider = backoffProvider ?? (attempt => TimeSpan.FromMilliseconds(300 * attempt));
    }

    public async Task<FaxQueueResult> QueueAsync(FaxRequest request, CancellationToken ct = default)
    {
        if (!_credentials.IsComplete)
        {
            return new FaxQueueResult(false, null, "SRFax credentials not configured — set them in Fax settings.");
        }

        var toFaxNumber = FaxNumberNormalizer.ToDialableOrNull(request.ToFaxNumber);
        if (toFaxNumber is null)
        {
            return new FaxQueueResult(false, null, $"Invalid fax number: {request.ToFaxNumber}");
        }

        var fields = new Dictionary<string, string>
        {
            ["action"] = "Queue_Fax",
            ["access_id"] = _credentials.AccessId,
            ["access_pwd"] = _credentials.AccessPassword,
            ["sCallerID"] = request.CallerId,
            ["sSenderEmail"] = request.SenderEmail,
            ["sFaxType"] = "SINGLE",
            ["sToFaxNumber"] = toFaxNumber,
            ["sFileName_1"] = request.FileName,
            ["sFileContent_1"] = Convert.ToBase64String(request.PdfBytes),
        };
        if (!string.IsNullOrWhiteSpace(request.AccountCode))
        {
            fields["sAccountCode"] = request.AccountCode;
        }

        string body;
        try
        {
            body = await PostWithRetryAsync(fields, ct);
        }
        catch (Exception ex)
        {
            return new FaxQueueResult(false, null, $"Couldn't reach SRFax: {ex.Message}");
        }

        return ParseQueueResponse(body);
    }

    public async Task<FaxStatusResult> GetStatusAsync(string faxId, CancellationToken ct = default)
    {
        if (!_credentials.IsComplete)
        {
            return new FaxStatusResult(false, FaxSendStatus.Failed, "SRFax credentials not configured.", null);
        }

        var fields = new Dictionary<string, string>
        {
            ["action"] = "Get_FaxStatus",
            ["access_id"] = _credentials.AccessId,
            ["access_pwd"] = _credentials.AccessPassword,
            ["sFaxDetailsID"] = faxId,
        };

        string body;
        try
        {
            body = await PostWithRetryAsync(fields, ct);
        }
        catch (Exception ex)
        {
            return new FaxStatusResult(false, FaxSendStatus.Failed, $"Couldn't reach SRFax: {ex.Message}", null);
        }

        return ParseStatusResponse(body);
    }

    public async Task<FaxAccountInfo> TestConnectionAsync(CancellationToken ct = default)
    {
        if (!_credentials.IsComplete)
        {
            return new FaxAccountInfo(false, null, "Enter an SRFax access id and password first.");
        }

        var fields = new Dictionary<string, string>
        {
            ["action"] = "Get_FaxUsage",
            ["access_id"] = _credentials.AccessId,
            ["access_pwd"] = _credentials.AccessPassword,
        };

        string body;
        try
        {
            body = await PostWithRetryAsync(fields, ct);
        }
        catch (Exception ex)
        {
            return new FaxAccountInfo(false, null, $"Couldn't reach SRFax: {ex.Message}");
        }

        try
        {
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            var status = root.TryGetProperty("Status", out var statusEl) ? statusEl.GetString() : null;
            var resultText = root.TryGetProperty("Result", out var resultEl) ? StringifyElement(resultEl) : null;

            // FaxAccountInfo.Summary's contract (both IFaxClient
            // implementations, so FaxSettingsViewModel.TestConnectionAsync
            // can display it verbatim without prepending its own
            // "Connected. " — that used to double up on Notifyre's
            // already-prefixed Summary): on success it ALWAYS already
            // starts with "Connected." — see NotifyreFaxClient's own
            // ParseAccountInfo for the other implementation.
            return string.Equals(status, "Success", StringComparison.OrdinalIgnoreCase)
                ? new FaxAccountInfo(true, string.IsNullOrWhiteSpace(resultText) ? "Connected." : $"Connected. {resultText}", null)
                : new FaxAccountInfo(false, null, resultText ?? "SRFax reported failure with no message.");
        }
        catch (Exception ex)
        {
            return new FaxAccountInfo(false, null, $"Couldn't parse SRFax response: {ex.Message}");
        }
    }

    /// <summary>Posts one form-encoded request, retrying up to
    /// _maxAttempts total attempts on a transport-level failure (a thrown
    /// exception, or an HTTP 5xx) with _backoffProvider's delay between
    /// attempts. An HTTP 4xx (a request-shape problem, never transient)
    /// fails immediately with no retry. Returns the raw response body on
    /// any HTTP 2xx — parsing/interpreting {"Status":...} happens one
    /// level up, exactly once, so an application-level Failed is never
    /// retried by this method either.</summary>
    private async Task<string> PostWithRetryAsync(Dictionary<string, string> fields, CancellationToken ct)
    {
        for (var attempt = 1; attempt <= _maxAttempts; attempt++)
        {
            HttpResponseMessage? response = null;
            Exception? transientError = null;
            try
            {
                response = await _httpClient.PostAsync(Endpoint, new FormUrlEncodedContent(fields), ct);
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
                    throw new HttpRequestException($"SRFax HTTP error {(int)response.StatusCode}");
                }

                transientError = new HttpRequestException($"SRFax HTTP error {(int)response.StatusCode}");
            }

            if (attempt >= _maxAttempts)
            {
                throw transientError ?? new HttpRequestException("SRFax request failed after retries.");
            }

            await Task.Delay(_backoffProvider(attempt), ct);
        }

        // Unreachable in practice (the loop above always returns or
        // throws) — kept so every path has a return for the compiler.
        throw new HttpRequestException("SRFax request failed after retries.");
    }

    private static FaxQueueResult ParseQueueResponse(string body)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            var status = root.TryGetProperty("Status", out var statusEl) ? statusEl.GetString() : null;
            var resultText = root.TryGetProperty("Result", out var resultEl) ? StringifyElement(resultEl) : null;

            if (string.Equals(status, "Success", StringComparison.OrdinalIgnoreCase))
            {
                return string.IsNullOrWhiteSpace(resultText)
                    ? new FaxQueueResult(false, null, "SRFax reported success with no fax id.")
                    : new FaxQueueResult(true, resultText, null);
            }

            return new FaxQueueResult(false, null, resultText ?? "SRFax reported failure with no message.");
        }
        catch (Exception ex)
        {
            return new FaxQueueResult(false, null, $"Couldn't parse SRFax response: {ex.Message}");
        }
    }

    private static FaxStatusResult ParseStatusResponse(string body)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            var status = root.TryGetProperty("Status", out var statusEl) ? statusEl.GetString() : null;

            if (!string.Equals(status, "Success", StringComparison.OrdinalIgnoreCase))
            {
                var errorText = root.TryGetProperty("Result", out var errEl) ? StringifyElement(errEl) : null;
                return new FaxStatusResult(false, FaxSendStatus.Failed, errorText ?? "SRFax reported failure with no message.", null);
            }

            if (!root.TryGetProperty("Result", out var resultEl))
            {
                return new FaxStatusResult(false, FaxSendStatus.Failed, "SRFax response had no Result.", null);
            }

            // The brief's documented shape is a single object; SRFax's
            // live API has also been observed wrapping it in a
            // one-element array for this call — both accepted here.
            var statusObject = resultEl.ValueKind == JsonValueKind.Array && resultEl.GetArrayLength() > 0
                ? resultEl[0]
                : resultEl;

            if (statusObject.ValueKind != JsonValueKind.Object)
            {
                return new FaxStatusResult(false, FaxSendStatus.Failed, "Couldn't parse SRFax status response.", null);
            }

            var sentStatus = statusObject.TryGetProperty("SentStatus", out var sentEl) ? sentEl.GetString() : null;
            var pages = statusObject.TryGetProperty("Pages", out var pagesEl) ? ParseIntOrNull(pagesEl) : null;
            var errorCode = statusObject.TryGetProperty("ErrorCode", out var errCodeEl) ? StringifyElement(errCodeEl) : null;

            var mapped = sentStatus?.Trim().ToLowerInvariant() switch
            {
                "sent" => FaxSendStatus.Sent,
                "in process" => FaxSendStatus.InProcess,
                "failed" => FaxSendStatus.Failed,
                _ => (FaxSendStatus?)null,
            };

            if (mapped is null)
            {
                return new FaxStatusResult(false, FaxSendStatus.Failed, $"Unrecognized SRFax status: {sentStatus}", pages);
            }

            var errorMessage = mapped == FaxSendStatus.Failed
                ? (string.IsNullOrWhiteSpace(errorCode) ? "SRFax reported the fax as failed." : errorCode)
                : null;
            return new FaxStatusResult(true, mapped.Value, errorMessage, pages);
        }
        catch (Exception ex)
        {
            return new FaxStatusResult(false, FaxSendStatus.Failed, $"Couldn't parse SRFax response: {ex.Message}", null);
        }
    }

    private static int? ParseIntOrNull(JsonElement el)
    {
        if (el.ValueKind == JsonValueKind.Number && el.TryGetInt32(out var n)) return n;
        if (el.ValueKind == JsonValueKind.String && int.TryParse(el.GetString(), out var s)) return s;
        return null;
    }

    private static string? StringifyElement(JsonElement el) => el.ValueKind switch
    {
        JsonValueKind.String => el.GetString(),
        JsonValueKind.Null or JsonValueKind.Undefined => null,
        _ => el.ToString(),
    };
}
