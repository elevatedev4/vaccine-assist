using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using VaccineAssist.Desktop.Services;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>A 401 with a token we believed valid forces ONE refresh and ONE
/// retry — never a loop. Synthetic tokens/URL.</summary>
public class VaccineApiServiceUnauthorizedRetryTests
{
    private sealed class SequenceHandler : HttpMessageHandler
    {
        private readonly Queue<HttpStatusCode> _statuses;

        public SequenceHandler(params HttpStatusCode[] statuses)
        {
            _statuses = new Queue<HttpStatusCode>(statuses);
        }

        public List<string?> AuthorizationHeaders { get; } = new();

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            AuthorizationHeaders.Add(request.Headers.Authorization?.ToString());
            var status = _statuses.Count > 0 ? _statuses.Dequeue() : HttpStatusCode.OK;
            var body = status == HttpStatusCode.OK ? "{\"lots\":[]}" : "{\"error\":\"Unauthorized.\"}";
            return Task.FromResult(new HttpResponseMessage(status) { Content = new StringContent(body) });
        }
    }

    private static async Task<(VaccineApiService Service, FakeAuthService Auth)> CreateAsync(SequenceHandler handler)
    {
        var auth = new FakeAuthService(AuthResult.Ok());
        await auth.SignInAsync("pharmacy@example.test", "pw"); // AccessToken = "fake-token"
        var service = new VaccineApiService(new HttpClient(handler) { BaseAddress = new Uri("https://cloud.example.test") }, auth);
        return (service, auth);
    }

    [Fact]
    public async Task A401ForcesOneRefreshAndOneRetryWithTheNewToken()
    {
        var handler = new SequenceHandler(HttpStatusCode.Unauthorized, HttpStatusCode.OK);
        var (service, auth) = await CreateAsync(handler);

        var lots = await service.GetLotsAsync();

        Assert.Empty(lots);
        Assert.Equal(new[] { "fake-token" }, auth.RejectedAccessTokens);
        Assert.Equal(new[] { "Bearer fake-token", "Bearer fake-refreshed-token" }, handler.AuthorizationHeaders);
    }

    [Fact]
    public async Task APersistent401IsRetriedOnlyOnceNotInALoop()
    {
        var handler = new SequenceHandler(HttpStatusCode.Unauthorized, HttpStatusCode.Unauthorized, HttpStatusCode.Unauthorized);
        var (service, auth) = await CreateAsync(handler);

        var ex = await Assert.ThrowsAsync<VaccineApiException>(() => service.GetLotsAsync());

        Assert.Equal(HttpStatusCode.Unauthorized, ex.StatusCode);
        Assert.Equal(2, handler.AuthorizationHeaders.Count);
        Assert.Single(auth.RejectedAccessTokens);
    }

    [Fact]
    public async Task NoRetryWhenTheRefreshProducedNoDifferentToken()
    {
        var handler = new SequenceHandler(HttpStatusCode.Unauthorized);
        var (service, auth) = await CreateAsync(handler);
        auth.TokenAfterUnauthorizedRefresh = "fake-token"; // throttled / unchanged

        await Assert.ThrowsAsync<VaccineApiException>(() => service.GetLotsAsync());

        Assert.Single(handler.AuthorizationHeaders);
    }

    [Fact]
    public async Task ANonAuthFailureIsNeverRetried()
    {
        var handler = new SequenceHandler(HttpStatusCode.InternalServerError);
        var (service, auth) = await CreateAsync(handler);

        await Assert.ThrowsAsync<VaccineApiException>(() => service.GetLotsAsync());

        Assert.Single(handler.AuthorizationHeaders);
        Assert.Empty(auth.RejectedAccessTokens);
    }
}
