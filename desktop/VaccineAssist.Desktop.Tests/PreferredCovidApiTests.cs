using System;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using VaccineAssist.Desktop.Services;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>GET/PUT /api/settings/preferred-covid mapping in VaccineApiService. Synthetic token/URL.</summary>
public class PreferredCovidApiTests
{
    private sealed class RecordingHandler : HttpMessageHandler
    {
        private readonly HttpStatusCode _status;
        private readonly string _body;

        public RecordingHandler(HttpStatusCode status, string body)
        {
            _status = status;
            _body = body;
        }

        public HttpMethod? Method { get; private set; }
        public string? Path { get; private set; }
        public string? Authorization { get; private set; }
        public string? RequestBody { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Method = request.Method;
            Path = request.RequestUri?.AbsolutePath;
            Authorization = request.Headers.Authorization?.ToString();
            RequestBody = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken);
            return new HttpResponseMessage(_status) { Content = new StringContent(_body) };
        }
    }

    private static async Task<VaccineApiService> CreateAsync(RecordingHandler handler)
    {
        var auth = new FakeAuthService(AuthResult.Ok());
        await auth.SignInAsync("pharmacy@example.test", "pw");
        return new VaccineApiService(new HttpClient(handler) { BaseAddress = new Uri("https://cloud.example.test") }, auth);
    }

    [Theory]
    [InlineData("{\"adult\":\"moderna\",\"kids\":\"moderna\",\"pending\":false}", "moderna")]
    [InlineData("{\"adult\":\"pfizer\",\"kids\":\"moderna\",\"pending\":false}", "pfizer")]
    [InlineData("{\"adult\":\"Moderna\",\"kids\":\"moderna\"}", "moderna")]   // case-insensitive, pending absent
    [InlineData("{\"adult\":\" pfizer \",\"kids\":\"moderna\"}", "pfizer")]   // whitespace tolerated
    public async Task GetMapsTheCloudAdultValue(string json, string expectedAdult)
    {
        var handler = new RecordingHandler(HttpStatusCode.OK, json);
        var service = await CreateAsync(handler);

        var setting = await service.GetPreferredCovidAsync();

        Assert.NotNull(setting);
        Assert.Equal(expectedAdult, setting!.Adult);
        Assert.Equal("moderna", setting.Kids);
        Assert.Equal(HttpMethod.Get, handler.Method);
        Assert.Equal("/api/settings/preferred-covid", handler.Path);
        Assert.Equal("Bearer fake-token", handler.Authorization);
    }

    [Theory]
    [InlineData("{\"adult\":\"moderna\",\"kids\":\"moderna\",\"saved\":true,\"pending\":false}", true)]
    [InlineData("{\"adult\":\"pfizer\",\"kids\":\"moderna\",\"saved\":false,\"pending\":false}", false)]
    [InlineData("{\"adult\":\"pfizer\",\"kids\":\"moderna\",\"pending\":false}", false)] // older cloud: no "saved" key
    public async Task GetReportsWhetherTheCloudHasAStoredValue(string json, bool expectedSaved)
    {
        var service = await CreateAsync(new RecordingHandler(HttpStatusCode.OK, json));

        var setting = await service.GetPreferredCovidAsync();

        Assert.NotNull(setting);
        Assert.Equal(expectedSaved, setting!.Saved);
    }

    [Fact]
    public async Task AuthCallsNeverReceiveTheCallersCancellationToken()
    {
        // A cancel (the sync's 3 s limit) in the middle of a Supabase token refresh could lose the rotated refresh token.
        var handler = new RecordingHandler(HttpStatusCode.OK, "{\"adult\":\"pfizer\",\"kids\":\"moderna\"}");
        var auth = new FakeAuthService(AuthResult.Ok());
        await auth.SignInAsync("pharmacy@example.test", "pw");
        var service = new VaccineApiService(new HttpClient(handler) { BaseAddress = new Uri("https://cloud.example.test") }, auth);
        using var cts = new CancellationTokenSource();

        await service.GetPreferredCovidAsync(cts.Token);
        await service.SetPreferredCovidAsync("pfizer", "moderna", cts.Token);

        Assert.NotEmpty(auth.AuthCallCancellationTokens);
        Assert.All(auth.AuthCallCancellationTokens, ct => Assert.False(ct.CanBeCanceled));
    }

    [Fact]
    public async Task TheRetryAfter401AlsoUsesANonCancellableAuthRefresh()
    {
        var handler = new SequenceStatusHandler();
        var auth = new FakeAuthService(AuthResult.Ok());
        await auth.SignInAsync("pharmacy@example.test", "pw");
        var service = new VaccineApiService(new HttpClient(handler) { BaseAddress = new Uri("https://cloud.example.test") }, auth);
        using var cts = new CancellationTokenSource();

        await service.GetPreferredCovidAsync(cts.Token);

        Assert.Equal(new[] { "fake-token" }, auth.RejectedAccessTokens);
        Assert.All(auth.AuthCallCancellationTokens, ct => Assert.False(ct.CanBeCanceled));
    }

    private sealed class SequenceStatusHandler : HttpMessageHandler
    {
        private int _calls;

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(_calls++ == 0
                ? new HttpResponseMessage(HttpStatusCode.Unauthorized) { Content = new StringContent("{\"error\":\"Unauthorized.\"}") }
                : new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"adult\":\"pfizer\",\"kids\":\"moderna\"}") });
    }

    [Theory]
    [InlineData("{\"adult\":\"pfizer\",\"kids\":\"moderna\",\"pending\":true}")] // table not created yet: defaults only, nothing to follow
    [InlineData("{\"adult\":\"novavax\",\"kids\":\"moderna\",\"pending\":false}")] // unknown product
    [InlineData("{\"kids\":\"moderna\"}")]                                          // adult missing
    [InlineData("{}")]
    public async Task GetReturnsNullWhenThereIsNothingUsableToFollow(string json)
    {
        var service = await CreateAsync(new RecordingHandler(HttpStatusCode.OK, json));

        Assert.Null(await service.GetPreferredCovidAsync());
    }

    [Theory]
    [InlineData(HttpStatusCode.NotFound)]
    [InlineData(HttpStatusCode.Unauthorized)]
    [InlineData(HttpStatusCode.InternalServerError)]
    public async Task GetThrowsOnHttpFailureSoTheCallerCanKeepItsLocalValue(HttpStatusCode status)
    {
        var service = await CreateAsync(new RecordingHandler(status, "{\"error\":\"nope\"}"));

        var ex = await Assert.ThrowsAsync<VaccineApiException>(() => service.GetPreferredCovidAsync());
        Assert.Equal(status, ex.StatusCode);
    }

    [Fact]
    public async Task PutSendsAdultAndKidsAsJsonWithTheBearerToken()
    {
        var handler = new RecordingHandler(HttpStatusCode.OK, "{\"adult\":\"moderna\",\"kids\":\"moderna\"}");
        var service = await CreateAsync(handler);

        var stored = await service.SetPreferredCovidAsync("moderna", "moderna");

        Assert.True(stored);
        Assert.Equal(HttpMethod.Put, handler.Method);
        Assert.Equal("/api/settings/preferred-covid", handler.Path);
        Assert.Equal("Bearer fake-token", handler.Authorization);
        Assert.Equal("{\"adult\":\"moderna\",\"kids\":\"moderna\"}", handler.RequestBody);
    }

    [Fact]
    public async Task PutReturnsFalseWhenTheCloudAnswersPending()
    {
        var service = await CreateAsync(new RecordingHandler(HttpStatusCode.OK, "{\"pending\":true}"));

        Assert.False(await service.SetPreferredCovidAsync("pfizer", "moderna"));
    }

    [Fact]
    public async Task PutThrowsOnHttpFailure()
    {
        var service = await CreateAsync(new RecordingHandler(HttpStatusCode.BadRequest, "{\"error\":\"bad\"}"));

        await Assert.ThrowsAsync<VaccineApiException>(() => service.SetPreferredCovidAsync("pfizer", "moderna"));
    }
}
