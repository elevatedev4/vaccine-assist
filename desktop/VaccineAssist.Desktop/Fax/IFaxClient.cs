namespace VaccineAssist.Desktop.Fax;

/// <summary>One outbound fax request — every field an IFaxClient
/// implementation could plausibly need to hand a vendor's send API,
/// deliberately vendor-neutral (no SRFax-specific field names here; see
/// SrFaxClient for how these map onto SRFax's actual form fields).</summary>
public sealed record FaxRequest(
    string ToFaxNumber,
    byte[] PdfBytes,
    string FileName,
    string CallerId,
    string SenderEmail,
    string? AccountCode = null);

/// <summary>Result of queuing one fax. Success is false whenever the
/// vendor call didn't produce a usable fax id — the caller (SrFaxClient
/// or a future implementation) is responsible for deciding when that's
/// worth a transient-error retry vs. a hard failure (see
/// IFaxClient.QueueAsync's own doc comment).</summary>
public sealed record FaxQueueResult(bool Success, string? FaxId, string? ErrorMessage);

/// <summary>Result of checking one queued fax's delivery status.</summary>
public sealed record FaxStatusResult(bool Success, FaxSendStatus Status, string? ErrorMessage, int? Pages);

/// <summary>Result of a "test connection" call — Will's brief: "also
/// implement Get_FaxUsage for a 'test connection' button," generalized
/// here to whatever lightweight authenticated call a vendor offers.</summary>
public sealed record FaxAccountInfo(bool Success, string? Summary, string? ErrorMessage);

/// <summary>
/// Vendor-neutral fax-sending abstraction — Will is still weighing
/// SRFax against Notifyre/Telnyx on price, so FaxRunOrchestrator,
/// FaxReceiptPoller, and the Settings window's "Test connection" button
/// all depend on THIS interface, never on SrFaxClient directly. Adding a
/// second vendor later is a new IFaxClient implementation plus a
/// FaxProvider case, not a change to any of those three.
/// </summary>
public interface IFaxClient
{
    /// <summary>Queues one fax for sending. Implementations should retry
    /// their OWN transient HTTP-level failures (network errors, 5xx) a
    /// few times with backoff, but must NEVER retry a vendor-reported
    /// application-level failure automatically — a retry there risks a
    /// double-send if the vendor actually processed the first attempt.</summary>
    Task<FaxQueueResult> QueueAsync(FaxRequest request, CancellationToken ct = default);

    /// <summary>Checks one already-queued fax's current delivery status by
    /// the vendor id QueueAsync returned.</summary>
    Task<FaxStatusResult> GetStatusAsync(string faxId, CancellationToken ct = default);

    /// <summary>Lightweight authenticated call with no side effects —
    /// backs the Settings window's "Test connection" button.</summary>
    Task<FaxAccountInfo> TestConnectionAsync(CancellationToken ct = default);
}
