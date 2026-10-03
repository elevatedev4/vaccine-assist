using System;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using VaccineAssist.Desktop.Services;
using VaccineAssist.Desktop.Settings;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// The refresh endpoint decides whether a failure is DEFINITIVE (delete
/// the stored session, show sign-in) or TRANSIENT (keep it, retry) purely
/// from the HTTP outcome — getting that wrong either strands users on a
/// dead token or deletes a good one over a wifi blip. Synthetic tokens/URL.
/// </summary>
public class HttpSupabaseTokenEndpointTests
{
    private sealed class StubHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> _respond;

        public StubHandler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> respond)
        {
            _respond = respond;
        }

        public HttpRequestMessage? LastRequest { get; private set; }
        public string? LastBody { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            LastRequest = request;
            LastBody = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken);
            return await _respond(request, cancellationToken);
        }
    }

    private static HttpSupabaseTokenEndpoint Create(StubHandler handler, TimeSpan? timeout = null) =>
        new(
            new HttpClient(handler),
            new AppSettings { SupabaseUrl = "https://example-project.supabase.test/", SupabaseAnonKey = "anon-key-for-tests" },
            timeout);

    private static StubHandler Respond(HttpStatusCode status, string body = "{}") =>
        new((_, _) => Task.FromResult(new HttpResponseMessage(status) { Content = new StringContent(body) }));

    [Fact]
    public async Task SuccessReturnsTheNewTokenPair()
    {
        var handler = Respond(HttpStatusCode.OK, "{\"access_token\":\"new-access\",\"refresh_token\":\"new-refresh\",\"expires_in\":3600}");

        var result = await Create(handler).RefreshAsync("old-refresh", CancellationToken.None);

        Assert.Equal(TokenRefreshKind.Success, result.Kind);
        Assert.Equal("new-access", result.AccessToken);
        Assert.Equal("new-refresh", result.RefreshToken);
    }

    [Fact]
    public async Task RefreshPostsTheRefreshTokenToTheTokenEndpointWithTheAnonKey()
    {
        var handler = Respond(HttpStatusCode.OK, "{\"access_token\":\"a\",\"refresh_token\":\"b\"}");

        await Create(handler).RefreshAsync("old-refresh", CancellationToken.None);

        Assert.Equal(HttpMethod.Post, handler.LastRequest!.Method);
        Assert.Equal("https://example-project.supabase.test/auth/v1/token?grant_type=refresh_token", handler.LastRequest.RequestUri!.ToString());
        Assert.Equal("anon-key-for-tests", handler.LastRequest.Headers.GetValues("apikey").Single());
        Assert.Contains("\"refresh_token\":\"old-refresh\"", handler.LastBody);
    }

    [Theory]
    [InlineData(HttpStatusCode.BadRequest, "{\"code\":400,\"error_code\":\"refresh_token_not_found\",\"msg\":\"Invalid Refresh Token: Refresh Token Not Found\"}")]
    [InlineData(HttpStatusCode.BadRequest, "{\"error_code\":\"refresh_token_already_used\",\"msg\":\"Invalid Refresh Token: Already Used\"}")]
    [InlineData(HttpStatusCode.BadRequest, "{\"error_code\":\"session_not_found\",\"msg\":\"Session not found\"}")]
    [InlineData(HttpStatusCode.BadRequest, "{\"error_code\":\"session_expired\"}")]
    [InlineData(HttpStatusCode.BadRequest, "{\"error\":\"invalid_grant\",\"error_description\":\"Invalid Refresh Token: Already Used\"}")]
    [InlineData(HttpStatusCode.Forbidden, "{\"error_code\":\"user_banned\",\"msg\":\"User is banned\"}")]
    [InlineData(HttpStatusCode.NotFound, "{\"error_code\":\"user_not_found\"}")]
    [InlineData(HttpStatusCode.BadRequest, "{\"msg\":\"Invalid Refresh Token: Session Expired\"}")]
    public async Task GoTrueShapedDeadSessionResponsesAreRejected(HttpStatusCode status, string body)
    {
        var result = await Create(Respond(status, body)).RefreshAsync("old-refresh", CancellationToken.None);

        Assert.Equal(TokenRefreshKind.Rejected, result.Kind);
        Assert.DoesNotContain("old-refresh", result.Detail);
    }

    [Theory]
    [InlineData(HttpStatusCode.Forbidden, "<html><body>Attention Required! | Cloudflare</body></html>")] // WAF on the shared pharmacy IP
    [InlineData(HttpStatusCode.Forbidden, "")]
    [InlineData(HttpStatusCode.NotFound, "<html>Blocked by your organization's web filter</html>")] // filtering proxy
    [InlineData(HttpStatusCode.Unauthorized, "{\"message\":\"Invalid API key\",\"hint\":\"Double check your Supabase `anon` or `service_role` API key.\"}")] // anon-key misconfig
    [InlineData(HttpStatusCode.Unauthorized, "{\"error\":\"Invalid API key\"}")]
    [InlineData(HttpStatusCode.BadRequest, "{\"error_code\":\"validation_failed\",\"msg\":\"bad request body\"}")]
    [InlineData(HttpStatusCode.UnprocessableEntity, "not json")]
    [InlineData(HttpStatusCode.BadRequest, "[]")]
    public async Task ClientErrorsThatAreNotGoTrueVerdictsAreTransientAndKeepTheSession(HttpStatusCode status, string body)
    {
        var result = await Create(Respond(status, body)).RefreshAsync("old-refresh", CancellationToken.None);

        Assert.Equal(TokenRefreshKind.Transient, result.Kind);
    }

    [Theory]
    [InlineData(HttpStatusCode.RequestTimeout)]
    [InlineData(HttpStatusCode.TooManyRequests)]
    [InlineData(HttpStatusCode.InternalServerError)]
    [InlineData(HttpStatusCode.BadGateway)]
    [InlineData(HttpStatusCode.ServiceUnavailable)]
    [InlineData(HttpStatusCode.GatewayTimeout)]
    public async Task ServerSideHiccupsAreTransientNeverARevokedSession(HttpStatusCode status)
    {
        var result = await Create(Respond(status)).RefreshAsync("old-refresh", CancellationToken.None);

        Assert.Equal(TokenRefreshKind.Transient, result.Kind);
    }

    [Fact]
    public async Task ANetworkFailureIsTransient()
    {
        var handler = new StubHandler((_, _) => throw new HttpRequestException("no route to host"));

        var result = await Create(handler).RefreshAsync("old-refresh", CancellationToken.None);

        Assert.Equal(TokenRefreshKind.Transient, result.Kind);
    }

    [Fact]
    public async Task ATimeoutIsTransient()
    {
        var handler = new StubHandler(async (_, token) =>
        {
            await Task.Delay(TimeSpan.FromSeconds(30), token);
            return new HttpResponseMessage(HttpStatusCode.OK);
        });

        var result = await Create(handler, TimeSpan.FromMilliseconds(50)).RefreshAsync("old-refresh", CancellationToken.None);

        Assert.Equal(TokenRefreshKind.Transient, result.Kind);
    }

    [Fact]
    public async Task ASuccessResponseWithoutATokenPairIsTransientNotAVerdictOnTheToken()
    {
        var result = await Create(Respond(HttpStatusCode.OK, "<html>captive portal</html>")).RefreshAsync("old-refresh", CancellationToken.None);

        Assert.Equal(TokenRefreshKind.Transient, result.Kind);
    }

    [Fact]
    public async Task MissingSupabaseConfigIsTransientSoNothingIsDeleted()
    {
        var endpoint = new HttpSupabaseTokenEndpoint(new HttpClient(Respond(HttpStatusCode.OK)), new AppSettings());

        var result = await endpoint.RefreshAsync("old-refresh", CancellationToken.None);

        Assert.Equal(TokenRefreshKind.Transient, result.Kind);
    }

    [Fact]
    public async Task LogoutUsesLocalScopeWithTheBearerTokenSoOtherWorkstationsStaySignedIn()
    {
        var handler = Respond(HttpStatusCode.NoContent);

        await Create(handler).LogoutLocalAsync("my-access", CancellationToken.None);

        Assert.Equal("https://example-project.supabase.test/auth/v1/logout?scope=local", handler.LastRequest!.RequestUri!.ToString());
        Assert.Equal("Bearer", handler.LastRequest.Headers.Authorization!.Scheme);
        Assert.Equal("my-access", handler.LastRequest.Headers.Authorization.Parameter);
    }

    [Fact]
    public async Task LogoutNeverThrowsEvenWhenTheNetworkIsDown()
    {
        var handler = new StubHandler((_, _) => throw new HttpRequestException("offline"));

        await Create(handler).LogoutLocalAsync("my-access", CancellationToken.None);
    }
}
