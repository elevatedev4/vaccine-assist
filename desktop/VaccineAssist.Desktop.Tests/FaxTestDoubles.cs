using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using VaccineAssist.Desktop.Fax;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// Hand-rolled fakes for the Fax/* interfaces (V-T53) — no mocking
/// framework, matching TestDoubles.cs's own convention.
/// </summary>
internal sealed class FakeHttpMessageHandler : HttpMessageHandler
{
    private readonly Queue<Func<HttpRequestMessage, HttpResponseMessage>> _responses = new();

    public List<HttpRequestMessage> Requests { get; } = new();
    public List<string> RequestBodies { get; } = new();

    /// <summary>Queues one response (or exception-throwing handler) to be
    /// returned for the next SendAsync call, in order.</summary>
    public void Enqueue(Func<HttpRequestMessage, HttpResponseMessage> responder) => _responses.Enqueue(responder);

    public void EnqueueJson(HttpStatusCode statusCode, string json) =>
        Enqueue(_ => new HttpResponseMessage(statusCode) { Content = new StringContent(json) });

    public void EnqueueException(Exception ex) => Enqueue(_ => throw ex);

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        Requests.Add(request);
        if (request.Content is not null)
        {
            RequestBodies.Add(await request.Content.ReadAsStringAsync(cancellationToken));
        }
        else
        {
            RequestBodies.Add("");
        }

        if (_responses.Count == 0)
        {
            throw new InvalidOperationException("FakeHttpMessageHandler: no more queued responses.");
        }

        var responder = _responses.Dequeue();
        return responder(request);
    }
}

/// <summary>Vendor-neutral fake IFaxClient — FaxRunOrchestrator/
/// FaxReceiptPoller tests drive this instead of a real SrFaxClient/HTTP
/// stack.</summary>
internal sealed class FakeFaxClient : IFaxClient
{
    public List<FaxRequest> QueuedRequests { get; } = new();
    public List<string> StatusChecks { get; } = new();

    /// <summary>Consumed in order for each QueueAsync call; falls back to
    /// a generic success once exhausted.</summary>
    public Queue<FaxQueueResult> QueueResults { get; } = new();

    /// <summary>faxId -> the result GetStatusAsync should return for it.</summary>
    public Dictionary<string, FaxStatusResult> StatusResults { get; } = new();

    public FaxAccountInfo TestConnectionResult { get; set; } = new(true, "ok", null);

    /// <summary>When set, the NEXT QueueAsync call awaits this before
    /// returning — lets a test hold a "run" in flight to assert
    /// FaxRunOrchestrator's serialization guard. Consumed (reset to null)
    /// the moment it's used, matching FakeAuthService's PendingSignIn
    /// convention in TestDoubles.cs.</summary>
    public TaskCompletionSource<bool>? HoldNextQueueUntil { get; set; }

    public async Task<FaxQueueResult> QueueAsync(FaxRequest request, CancellationToken ct = default)
    {
        QueuedRequests.Add(request);

        var hold = HoldNextQueueUntil;
        if (hold is not null)
        {
            HoldNextQueueUntil = null;
            await hold.Task;
        }

        var result = QueueResults.Count > 0 ? QueueResults.Dequeue() : new FaxQueueResult(true, $"fax-{QueuedRequests.Count}", null);
        return result;
    }

    public Task<FaxStatusResult> GetStatusAsync(string faxId, CancellationToken ct = default)
    {
        StatusChecks.Add(faxId);
        var result = StatusResults.TryGetValue(faxId, out var r) ? r : new FaxStatusResult(true, FaxSendStatus.InProcess, null, null);
        return Task.FromResult(result);
    }

    public Task<FaxAccountInfo> TestConnectionAsync(CancellationToken ct = default) => Task.FromResult(TestConnectionResult);
}

/// <summary>Throws from Build — used to test FaxRunOrchestrator's PDF-build
/// failure path.</summary>
internal sealed class FaultyPdfBuilder : IVaccineRecordPdfBuilder
{
    public VaccinePdfResult Build(PatientFaxGroup group, FaxSettings faxSettings) =>
        throw new InvalidOperationException("simulated PDF build failure");
}
