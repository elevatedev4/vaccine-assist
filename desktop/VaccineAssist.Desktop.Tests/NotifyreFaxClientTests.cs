using System;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Threading.Tasks;
using VaccineAssist.Desktop.Fax;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// Unit tests for NotifyreFaxClient — see that class's own doc comment for
/// where these request/response shapes came from (docs.notifyre.com,
/// rendered and read directly, not typed from memory) and the two places
/// the original brief's assumptions didn't match the real API. "test-token"
/// below is a synthetic fixture, never a real Notifyre API token.
/// </summary>
public class NotifyreFaxClientTests
{
    private static readonly FaxCredentials Credentials = new() { ApiToken = "test-token" };

    private static NotifyreFaxClient MakeClient(FakeHttpMessageHandler handler, int maxAttempts = 3) =>
        new(new HttpClient(handler), Credentials, maxAttempts, _ => TimeSpan.Zero);

    private const string SendSuccessJson = "{\"Success\":true,\"StatusCode\":200,\"Message\":\"OK\",\"Payload\":{\"FaxID\":\"fax-123\",\"FriendlyID\":\"F-1\"},\"Errors\":[]}";

    [Fact]
    public async Task QueueAsyncEncodesEveryRequiredField()
    {
        var handler = new FakeHttpMessageHandler();
        handler.EnqueueJson(HttpStatusCode.OK, SendSuccessJson);
        var client = MakeClient(handler);

        var request = new FaxRequest("5555550100", new byte[] { 1, 2, 3 }, "test.pdf", "5555550101", "sender@example.com");
        await client.QueueAsync(request);

        Assert.Single(handler.Requests);
        var sent = handler.Requests[0];
        Assert.Equal(HttpMethod.Post, sent.Method);
        Assert.Equal("https://api.notifyre.com/fax/send", sent.RequestUri!.ToString());
        Assert.True(sent.Headers.TryGetValues("x-api-token", out var tokenValues));
        Assert.Equal("test-token", tokenValues!.Single());

        var body = handler.RequestBodies[0];
        Assert.Contains("\"Recipients\"", body);
        Assert.Contains("\"Type\":\"fax_number\"", body);
        Assert.Contains("\"Value\":\"+15555550100\"", body);
        Assert.Contains("\"Filename\":\"test.pdf\"", body);
        Assert.Contains("\"Data\":\"" + Convert.ToBase64String(new byte[] { 1, 2, 3 }) + "\"", body);
        Assert.Contains("\"IsHighQuality\":true", body);
    }

    [Fact]
    public async Task QueueAsyncSuccessReturnsFaxId()
    {
        var handler = new FakeHttpMessageHandler();
        handler.EnqueueJson(HttpStatusCode.OK, SendSuccessJson);
        var client = MakeClient(handler);

        var result = await client.QueueAsync(new FaxRequest("5555550100", new byte[] { 1 }, "a.pdf", "5555550101", "s@example.com"));

        Assert.True(result.Success);
        Assert.Equal("fax-123", result.FaxId);
    }

    [Fact]
    public async Task QueueAsyncFailedIsNeverRetried()
    {
        var handler = new FakeHttpMessageHandler();
        handler.EnqueueJson(HttpStatusCode.OK, "{\"Success\":false,\"StatusCode\":400,\"Message\":\"Invalid recipient\",\"Payload\":null,\"Errors\":[]}");
        var client = MakeClient(handler);

        var result = await client.QueueAsync(new FaxRequest("5555550100", new byte[] { 1 }, "a.pdf", "5555550101", "s@example.com"));

        Assert.False(result.Success);
        Assert.Equal("Invalid recipient", result.ErrorMessage);
        // Only ONE HTTP call — a vendor-level failure must never be retried.
        Assert.Single(handler.Requests);
    }

    [Fact]
    public async Task QueueAsyncFailedFallsBackToErrorsArrayWhenMessageIsBlank()
    {
        var handler = new FakeHttpMessageHandler();
        handler.EnqueueJson(HttpStatusCode.OK, "{\"Success\":false,\"Message\":\"\",\"Errors\":[\"Recipient fax number is invalid\"]}");
        var client = MakeClient(handler);

        var result = await client.QueueAsync(new FaxRequest("5555550100", new byte[] { 1 }, "a.pdf", "5555550101", "s@example.com"));

        Assert.False(result.Success);
        Assert.Equal("Recipient fax number is invalid", result.ErrorMessage);
    }

    [Fact]
    public async Task QueueAsyncMalformedJsonReturnsFailureNotAnException()
    {
        var handler = new FakeHttpMessageHandler();
        handler.EnqueueJson(HttpStatusCode.OK, "not json at all {{{");
        var client = MakeClient(handler);

        var result = await client.QueueAsync(new FaxRequest("5555550100", new byte[] { 1 }, "a.pdf", "5555550101", "s@example.com"));

        Assert.False(result.Success);
        Assert.NotNull(result.ErrorMessage);
    }

    [Fact]
    public async Task QueueAsyncInvalidFaxNumberFailsFastWithNoHttpCall()
    {
        var handler = new FakeHttpMessageHandler();
        var client = MakeClient(handler);

        var result = await client.QueueAsync(new FaxRequest("555-0100", new byte[] { 1 }, "a.pdf", "5555550101", "s@example.com"));

        Assert.False(result.Success);
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task QueueAsyncMissingTokenFailsFastWithNoHttpCall()
    {
        var handler = new FakeHttpMessageHandler();
        var client = new NotifyreFaxClient(new HttpClient(handler), new FaxCredentials());

        var result = await client.QueueAsync(new FaxRequest("5555550100", new byte[] { 1 }, "a.pdf", "5555550101", "s@example.com"));

        Assert.False(result.Success);
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task TransientNetworkErrorIsRetriedThenSucceeds()
    {
        var handler = new FakeHttpMessageHandler();
        handler.EnqueueException(new HttpRequestException("simulated transient failure"));
        handler.EnqueueJson(HttpStatusCode.OK, SendSuccessJson);
        var client = MakeClient(handler);

        var result = await client.QueueAsync(new FaxRequest("5555550100", new byte[] { 1 }, "a.pdf", "5555550101", "s@example.com"));

        Assert.True(result.Success);
        Assert.Equal(2, handler.Requests.Count);
    }

    [Fact]
    public async Task Http5xxIsRetriedUpToMaxAttemptsThenFails()
    {
        var handler = new FakeHttpMessageHandler();
        handler.EnqueueJson(HttpStatusCode.InternalServerError, "");
        handler.EnqueueJson(HttpStatusCode.InternalServerError, "");
        handler.EnqueueJson(HttpStatusCode.InternalServerError, "");
        var client = MakeClient(handler, maxAttempts: 3);

        var result = await client.QueueAsync(new FaxRequest("5555550100", new byte[] { 1 }, "a.pdf", "5555550101", "s@example.com"));

        Assert.False(result.Success);
        Assert.Equal(3, handler.Requests.Count);
    }

    [Fact]
    public async Task Http4xxIsNeverRetried()
    {
        var handler = new FakeHttpMessageHandler();
        handler.EnqueueJson(HttpStatusCode.Unauthorized, "{\"Success\":false,\"Message\":\"Invalid token\"}");
        var client = MakeClient(handler);

        var result = await client.QueueAsync(new FaxRequest("5555550100", new byte[] { 1 }, "a.pdf", "5555550101", "s@example.com"));

        Assert.False(result.Success);
        Assert.Single(handler.Requests);
    }

    [Fact]
    public async Task BuildRequestSetsExactlyOneTrimmedXApiTokenHeaderFromAWhitespacePaddedToken()
    {
        // V-T53 401 follow-up (Will, 2026-09-23): a pasted token with a
        // trailing newline/space is a valid HTTP header byte-wise (so it's
        // sent, not thrown/rejected) but won't match Notifyre's stored
        // token — this is the client's own defense-in-depth trim,
        // independent of FaxSettingsViewModel's Save/Test trim.
        var handler = new FakeHttpMessageHandler();
        handler.EnqueueJson(HttpStatusCode.OK, "{\"Success\":true,\"Payload\":{\"Numbers\":[]}}");
        var client = new NotifyreFaxClient(new HttpClient(handler), new FaxCredentials { ApiToken = "  test-token\r\n" }, backoffProvider: _ => TimeSpan.Zero);

        await client.TestConnectionAsync();

        Assert.Single(handler.Requests);
        var sent = handler.Requests[0];
        Assert.True(sent.Headers.TryGetValues("x-api-token", out var tokenValues));
        Assert.Equal("test-token", tokenValues!.Single());
    }

    [Theory]
    [InlineData("​test-token")] // zero-width space
    [InlineData("﻿test-token")] // BOM / zero-width no-break space
    [InlineData("\"test-token\"")] // surrounding quotes
    [InlineData("Bearer test-token")] // scheme prefix
    [InlineData("  test-token  ")] // ordinary whitespace
    public async Task BuildRequestSendsTheNormalizedTokenForEveryKnownPasteArtifact(string rawToken)
    {
        // V-T53 follow-up (Will, 2026-09-25): none of these should ever
        // reach Notifyre as anything other than the bare "test-token" —
        // each one used to produce the exact 401 "Access denied" Notifyre
        // also returns for a MISSING token, making it indistinguishable
        // from "the token itself is wrong."
        var handler = new FakeHttpMessageHandler();
        handler.EnqueueJson(HttpStatusCode.OK, "{\"Success\":true,\"Payload\":{\"Numbers\":[]}}");
        var client = new NotifyreFaxClient(new HttpClient(handler), new FaxCredentials { ApiToken = rawToken }, backoffProvider: _ => TimeSpan.Zero);

        await client.TestConnectionAsync();

        Assert.Single(handler.Requests);
        var sent = handler.Requests[0];
        Assert.True(sent.Headers.TryGetValues("x-api-token", out var tokenValues));
        Assert.Equal("test-token", tokenValues!.Single());
    }

    [Fact]
    public async Task TestConnectionAsyncOn401SurfacesTheHttpStatusAndNotifyresErrorBody()
    {
        // Will's brief: "Make Test connection show the HTTP status +
        // Notifyre's error body text in the dialog and log (not just
        // '401')."
        var handler = new FakeHttpMessageHandler();
        handler.EnqueueJson(HttpStatusCode.Unauthorized, "{\"success\":false,\"message\":\"Invalid API token\"}");
        var client = MakeClient(handler);

        var result = await client.TestConnectionAsync();

        Assert.False(result.Success);
        Assert.Contains("401", result.ErrorMessage);
        Assert.Contains("Invalid API token", result.ErrorMessage);
    }

    [Fact]
    public async Task TestConnectionAsyncOn401IsNeverRetried()
    {
        var handler = new FakeHttpMessageHandler();
        handler.EnqueueJson(HttpStatusCode.Unauthorized, "{\"success\":false,\"message\":\"Invalid API token\"}");
        var client = MakeClient(handler);

        await client.TestConnectionAsync();

        Assert.Single(handler.Requests);
    }

    [Theory]
    [InlineData("queued", FaxSendStatus.Queued)]
    [InlineData("accepted", FaxSendStatus.Queued)]
    [InlineData("processing", FaxSendStatus.InProcess)]
    [InlineData("sending", FaxSendStatus.InProcess)]
    [InlineData("in_progress", FaxSendStatus.InProcess)]
    [InlineData("successful", FaxSendStatus.Sent)]
    [InlineData("delivered", FaxSendStatus.Sent)]
    [InlineData("failed", FaxSendStatus.Failed)]
    [InlineData("no-answer", FaxSendStatus.Failed)]
    [InlineData("busy", FaxSendStatus.Failed)]
    [InlineData("cancelled", FaxSendStatus.Failed)]
    public async Task GetStatusAsyncMapsEveryDocumentedStatus(string notifyreStatus, FaxSendStatus expected)
    {
        var handler = new FakeHttpMessageHandler();
        handler.EnqueueJson(HttpStatusCode.OK,
            $"{{\"Success\":true,\"Payload\":{{\"Faxes\":[{{\"ID\":\"fax-123\",\"Status\":\"{notifyreStatus}\",\"StatusMessage\":\"reason\",\"Pages\":2}}],\"Total\":1}}}}");
        var client = MakeClient(handler);

        var result = await client.GetStatusAsync("fax-123");

        Assert.True(result.Success);
        Assert.Equal(expected, result.Status);
        Assert.Equal(2, result.Pages);
    }

    [Fact]
    public async Task GetStatusAsyncQueriesTheListEndpointSortedDescending()
    {
        var handler = new FakeHttpMessageHandler();
        handler.EnqueueJson(HttpStatusCode.OK, "{\"Success\":true,\"Payload\":{\"Faxes\":[],\"Total\":0}}");
        var client = MakeClient(handler);

        await client.GetStatusAsync("fax-123");

        Assert.Single(handler.Requests);
        var sent = handler.Requests[0];
        Assert.Equal(HttpMethod.Get, sent.Method);
        Assert.Contains("/fax/send?", sent.RequestUri!.ToString());
        Assert.Contains("sort=desc", sent.RequestUri!.ToString());
    }

    [Fact]
    public async Task GetStatusAsyncReturnsFailureWhenIdIsNotInTheList()
    {
        var handler = new FakeHttpMessageHandler();
        handler.EnqueueJson(HttpStatusCode.OK,
            "{\"Success\":true,\"Payload\":{\"Faxes\":[{\"ID\":\"some-other-fax\",\"Status\":\"successful\"}],\"Total\":1}}");
        var client = MakeClient(handler);

        var result = await client.GetStatusAsync("fax-123");

        Assert.False(result.Success);
        Assert.Contains("fax-123", result.ErrorMessage);
    }

    [Fact]
    public async Task GetStatusAsyncUnrecognizedStatusReturnsFailureNotAnException()
    {
        var handler = new FakeHttpMessageHandler();
        handler.EnqueueJson(HttpStatusCode.OK,
            "{\"Success\":true,\"Payload\":{\"Faxes\":[{\"ID\":\"fax-123\",\"Status\":\"something-new\"}],\"Total\":1}}");
        var client = MakeClient(handler);

        var result = await client.GetStatusAsync("fax-123");

        Assert.False(result.Success);
        Assert.Contains("something-new", result.ErrorMessage);
    }

    [Fact]
    public async Task GetStatusAsyncMissingTokenFailsFastWithNoHttpCall()
    {
        var handler = new FakeHttpMessageHandler();
        var client = new NotifyreFaxClient(new HttpClient(handler), new FaxCredentials());

        var result = await client.GetStatusAsync("fax-123");

        Assert.False(result.Success);
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task TestConnectionAsyncParsesSuccessWithEmptyNumberList()
    {
        var handler = new FakeHttpMessageHandler();
        handler.EnqueueJson(HttpStatusCode.OK, "{\"Success\":true,\"StatusCode\":200,\"Payload\":{\"Numbers\":[]}}");
        var client = MakeClient(handler);

        var result = await client.TestConnectionAsync();

        Assert.True(result.Success);
    }

    [Fact]
    public async Task TestConnectionAsyncParsesSuccessWithNumbers()
    {
        var handler = new FakeHttpMessageHandler();
        handler.EnqueueJson(HttpStatusCode.OK, "{\"Success\":true,\"Payload\":{\"Numbers\":[{\"Number\":\"+15555550100\"}]}}");
        var client = MakeClient(handler);

        var result = await client.TestConnectionAsync();

        Assert.True(result.Success);
        Assert.Contains("1 fax number", result.Summary);
    }

    [Fact]
    public async Task TestConnectionAsyncParsesFailure()
    {
        var handler = new FakeHttpMessageHandler();
        handler.EnqueueJson(HttpStatusCode.OK, "{\"Success\":false,\"Message\":\"Invalid API token\"}");
        var client = MakeClient(handler);

        var result = await client.TestConnectionAsync();

        Assert.False(result.Success);
        Assert.Equal("Invalid API token", result.ErrorMessage);
    }

    [Fact]
    public async Task TestConnectionAsyncMissingTokenFailsFastWithNoHttpCall()
    {
        var handler = new FakeHttpMessageHandler();
        var client = new NotifyreFaxClient(new HttpClient(handler), new FaxCredentials());

        var result = await client.TestConnectionAsync();

        Assert.False(result.Success);
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task ResponseParsingIsCaseInsensitiveForLowerCamelCaseKeys()
    {
        // Notifyre's live responses have been observed using lowerCamelCase
        // keys ("payload"/"success"/"faxID") even though the docs' schema
        // tables and cURL examples show PascalCase — this guards against
        // trusting only one casing.
        var handler = new FakeHttpMessageHandler();
        handler.EnqueueJson(HttpStatusCode.OK, "{\"success\":true,\"statusCode\":200,\"payload\":{\"faxID\":\"fax-lower\",\"friendlyID\":\"F-2\"}}");
        var client = MakeClient(handler);

        var result = await client.QueueAsync(new FaxRequest("5555550100", new byte[] { 1 }, "a.pdf", "5555550101", "s@example.com"));

        Assert.True(result.Success);
        Assert.Equal("fax-lower", result.FaxId);
    }
}
