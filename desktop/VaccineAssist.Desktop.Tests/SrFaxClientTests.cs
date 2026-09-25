using System;
using System.Net;
using System.Net.Http;
using System.Threading.Tasks;
using VaccineAssist.Desktop.Fax;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

public class SrFaxClientTests
{
    private static readonly FaxCredentials Credentials = new() { AccessId = "test-access-id", AccessPassword = "test-password" };

    private static SrFaxClient MakeClient(FakeHttpMessageHandler handler, int maxAttempts = 3) =>
        new(new HttpClient(handler), Credentials, maxAttempts, _ => TimeSpan.Zero);

    [Fact]
    public async Task QueueAsyncEncodesEveryRequiredFormField()
    {
        var handler = new FakeHttpMessageHandler();
        handler.EnqueueJson(HttpStatusCode.OK, "{\"Status\":\"Success\",\"Result\":\"12345\"}");
        var client = MakeClient(handler);

        var request = new FaxRequest("5555550100", new byte[] { 1, 2, 3 }, "test.pdf", "5555550101", "sender@example.com", "ACCT1");
        await client.QueueAsync(request);

        Assert.Single(handler.Requests);
        var body = handler.RequestBodies[0];
        Assert.Contains("action=Queue_Fax", body);
        Assert.Contains("access_id=test-access-id", body);
        Assert.Contains("sToFaxNumber=5555550100", body);
        Assert.Contains("sCallerID=5555550101", body);
        Assert.Contains("sFaxType=SINGLE", body);
        Assert.Contains("sAccountCode=ACCT1", body);
        Assert.Contains("sFileContent_1=", body);
    }

    [Fact]
    public async Task QueueAsyncSuccessReturnsFaxId()
    {
        var handler = new FakeHttpMessageHandler();
        handler.EnqueueJson(HttpStatusCode.OK, "{\"Status\":\"Success\",\"Result\":\"98765\"}");
        var client = MakeClient(handler);

        var result = await client.QueueAsync(new FaxRequest("5555550100", new byte[] { 1 }, "a.pdf", "5555550101", "s@example.com"));

        Assert.True(result.Success);
        Assert.Equal("98765", result.FaxId);
    }

    [Fact]
    public async Task QueueAsyncFailedIsNeverRetried()
    {
        var handler = new FakeHttpMessageHandler();
        handler.EnqueueJson(HttpStatusCode.OK, "{\"Status\":\"Failed\",\"Result\":\"Invalid fax number\"}");
        var client = MakeClient(handler);

        var result = await client.QueueAsync(new FaxRequest("5555550100", new byte[] { 1 }, "a.pdf", "5555550101", "s@example.com"));

        Assert.False(result.Success);
        Assert.Equal("Invalid fax number", result.ErrorMessage);
        // Only ONE HTTP call — a vendor-level "Failed" must never be retried.
        Assert.Single(handler.Requests);
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
    public async Task TransientNetworkErrorIsRetriedThenSucceeds()
    {
        var handler = new FakeHttpMessageHandler();
        handler.EnqueueException(new HttpRequestException("simulated transient failure"));
        handler.EnqueueJson(HttpStatusCode.OK, "{\"Status\":\"Success\",\"Result\":\"111\"}");
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

    [Theory]
    [InlineData("Sent", FaxSendStatus.Sent)]
    [InlineData("In Process", FaxSendStatus.InProcess)]
    [InlineData("Failed", FaxSendStatus.Failed)]
    public async Task GetStatusAsyncMapsEveryDocumentedStatus(string srFaxStatus, FaxSendStatus expected)
    {
        var handler = new FakeHttpMessageHandler();
        handler.EnqueueJson(HttpStatusCode.OK,
            $"{{\"Status\":\"Success\",\"Result\":{{\"SentStatus\":\"{srFaxStatus}\",\"ErrorCode\":\"\",\"Pages\":\"1\",\"Duration\":\"10\"}}}}");
        var client = MakeClient(handler);

        var result = await client.GetStatusAsync("12345");

        Assert.True(result.Success);
        Assert.Equal(expected, result.Status);
    }

    [Fact]
    public async Task GetStatusAsyncAcceptsAnArrayWrappedResult()
    {
        var handler = new FakeHttpMessageHandler();
        handler.EnqueueJson(HttpStatusCode.OK,
            "{\"Status\":\"Success\",\"Result\":[{\"SentStatus\":\"Sent\",\"Pages\":\"2\"}]}");
        var client = MakeClient(handler);

        var result = await client.GetStatusAsync("12345");

        Assert.True(result.Success);
        Assert.Equal(FaxSendStatus.Sent, result.Status);
        Assert.Equal(2, result.Pages);
    }

    [Fact]
    public async Task MissingCredentialsFailFastWithNoHttpCall()
    {
        var handler = new FakeHttpMessageHandler();
        var client = new SrFaxClient(new HttpClient(handler), new FaxCredentials());

        var result = await client.QueueAsync(new FaxRequest("5555550100", new byte[] { 1 }, "a.pdf", "5555550101", "s@example.com"));

        Assert.False(result.Success);
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task TestConnectionAsyncParsesSuccess()
    {
        var handler = new FakeHttpMessageHandler();
        handler.EnqueueJson(HttpStatusCode.OK, "{\"Status\":\"Success\",\"Result\":\"5 faxes this month\"}");
        var client = MakeClient(handler);

        var result = await client.TestConnectionAsync();

        Assert.True(result.Success);
    }

    [Fact]
    public async Task TestConnectionAsyncSuccessSummaryAlwaysStartsWithConnected()
    {
        // FaxAccountInfo.Summary's contract (shared with NotifyreFaxClient
        // — see its own ParseAccountInfo): on success it always already
        // starts with "Connected." so FaxSettingsViewModel can display it
        // verbatim without prepending its own "Connected. " (that used to
        // double up as "Connected. Connected. ..." for Notifyre).
        var handler = new FakeHttpMessageHandler();
        handler.EnqueueJson(HttpStatusCode.OK, "{\"Status\":\"Success\",\"Result\":\"5 faxes this month\"}");
        var client = MakeClient(handler);

        var result = await client.TestConnectionAsync();

        Assert.True(result.Success);
        Assert.StartsWith("Connected.", result.Summary);
        Assert.Contains("5 faxes this month", result.Summary);
    }

    [Fact]
    public async Task TestConnectionAsyncSuccessSummaryFallsBackToPlainConnectedWhenResultIsBlank()
    {
        var handler = new FakeHttpMessageHandler();
        handler.EnqueueJson(HttpStatusCode.OK, "{\"Status\":\"Success\",\"Result\":\"\"}");
        var client = MakeClient(handler);

        var result = await client.TestConnectionAsync();

        Assert.True(result.Success);
        Assert.Equal("Connected.", result.Summary);
    }
}
