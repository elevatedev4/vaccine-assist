using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using VaccineAssist.Desktop.Services;
using VaccineAssist.Desktop.Settings;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// SessionKeeper is the fix for "people re-sign-in 1-2 times a day per
/// workstation" (Will, 2026-10-03). Root cause: refresh tokens rotate on
/// every use and the old code persisted the token only at sign-in/startup
/// while the SDK's own timer rotated it again in memory, so a restart
/// presented an already-used token and GoTrue revoked the session.
/// RotationAwareEndpoint below behaves like GoTrue (single-use refresh
/// tokens, reuse = revoked), so these tests fail for any implementation
/// that ever persists or presents a stale token. All tokens are synthetic.
/// </summary>
public class SessionKeeperTests
{
    private static readonly DateTime T0 = new(2026, 10, 3, 12, 0, 0, DateTimeKind.Utc);

    // ---- Fakes -------------------------------------------------------

    private static string FakeJwt(DateTime expiresUtc)
    {
        static string B64(string json) =>
            Convert.ToBase64String(Encoding.UTF8.GetBytes(json)).TrimEnd('=').Replace('+', '-').Replace('/', '_');

        var exp = new DateTimeOffset(expiresUtc, TimeSpan.Zero).ToUnixTimeSeconds();
        return $"{B64("{\"alg\":\"none\"}")}.{B64($"{{\"exp\":{exp}}}")}.sig";
    }

    private sealed class FakeClock
    {
        public DateTime Now { get; set; } = T0;
    }

    /// <summary>Single-use refresh tokens like GoTrue: presenting anything
    /// but the current valid token is Rejected.</summary>
    private sealed class RotationAwareEndpoint : ISupabaseTokenEndpoint
    {
        private readonly FakeClock _clock;
        private int _counter;

        public RotationAwareEndpoint(FakeClock clock, string initialRefreshToken)
        {
            _clock = clock;
            ValidRefreshToken = initialRefreshToken;
        }

        public string ValidRefreshToken { get; private set; }
        public int RefreshCallCount { get; private set; }
        public List<string> PresentedRefreshTokens { get; } = new();
        public List<string> LoggedOutAccessTokens { get; } = new();

        /// <summary>Queued failures returned before normal behaviour.</summary>
        public Queue<TokenRefreshResult> ScriptedResults { get; } = new();

        /// <summary>When set, RefreshAsync waits on it (holds a refresh
        /// "in flight").</summary>
        public TaskCompletionSource<bool>? Gate { get; set; }

        /// <summary>When set, every issued access token expires then —
        /// simulates a local clock far AHEAD of real time (tokens look
        /// already-expired the moment they are issued).</summary>
        public DateTime? FixedExpiry { get; set; }

        public string IssueAccessToken() => FakeJwt(FixedExpiry ?? _clock.Now.AddHours(1));

        public async Task<TokenRefreshResult> RefreshAsync(string refreshToken, CancellationToken cancellationToken)
        {
            RefreshCallCount++;
            PresentedRefreshTokens.Add(refreshToken);

            if (Gate is not null)
            {
                await Gate.Task;
            }

            if (ScriptedResults.Count > 0)
            {
                return ScriptedResults.Dequeue();
            }

            if (refreshToken != ValidRefreshToken)
            {
                return TokenRefreshResult.Rejected("HTTP 400 (refresh_token_already_used)");
            }

            ValidRefreshToken = $"refresh-{++_counter}";
            return TokenRefreshResult.Success(IssueAccessToken(), ValidRefreshToken);
        }

        public Task LogoutLocalAsync(string accessToken, CancellationToken cancellationToken)
        {
            LoggedOutAccessTokens.Add(accessToken);
            return Task.CompletedTask;
        }
    }

    private static SessionKeeper CreateKeeper(
        FakeSessionStore store,
        ISupabaseTokenEndpoint endpoint,
        FakeClock clock,
        List<TimeSpan>? delays = null,
        List<string>? log = null)
    {
        return new SessionKeeper(
            store,
            endpoint,
            utcNow: () => clock.Now,
            delay: (span, _) =>
            {
                delays?.Add(span);
                return Task.CompletedTask;
            },
            log: log is null ? null : log.Add);
    }

    // ---- Restart / restore ------------------------------------------

    [Fact]
    public async Task RestartWithAStillValidAccessTokenRestoresSilentlyWithoutTouchingTheNetwork()
    {
        var clock = new FakeClock();
        var endpoint = new RotationAwareEndpoint(clock, "refresh-0");
        var store = new FakeSessionStore();
        var persisted = new PersistedSession(FakeJwt(clock.Now.AddMinutes(30)), "refresh-0", clock.Now.AddDays(-10));
        var keeper = CreateKeeper(store, endpoint, clock);

        var result = await keeper.RestoreAsync(persisted);

        Assert.True(result.Success);
        Assert.Equal(0, endpoint.RefreshCallCount);
        Assert.Equal(persisted.AccessToken, keeper.AccessToken);
        Assert.True(keeper.HasSession);
    }

    [Fact]
    public async Task ExpiredAccessTokenIsRefreshedOnRestoreAndTheRotatedPairIsPersistedKeepingTheOriginalIssuedAt()
    {
        var clock = new FakeClock();
        var endpoint = new RotationAwareEndpoint(clock, "refresh-0");
        var issuedAt = clock.Now.AddDays(-40);
        var store = new FakeSessionStore(new PersistedSession(FakeJwt(clock.Now.AddHours(-3)), "refresh-0", issuedAt));
        var keeper = CreateKeeper(store, endpoint, clock);

        var result = await keeper.RestoreAsync(store.Session!);

        Assert.True(result.Success);
        Assert.Equal(1, endpoint.RefreshCallCount);
        Assert.Equal("refresh-1", keeper.RefreshToken);
        Assert.Equal(1, store.SaveCallCount);
        Assert.Equal("refresh-1", store.LastSaved!.RefreshToken);
        Assert.Equal(issuedAt, store.LastSaved.IssuedAtUtc); // ceiling is anchored to the last interactive sign-in
    }

    [Fact]
    public async Task UnreadableAccessTokenForcesARefreshToBeSafe()
    {
        var clock = new FakeClock();
        var endpoint = new RotationAwareEndpoint(clock, "refresh-0");
        var store = new FakeSessionStore(new PersistedSession("not-a-jwt", "refresh-0", clock.Now.AddDays(-1)));
        var keeper = CreateKeeper(store, endpoint, clock);

        Assert.True((await keeper.RestoreAsync(store.Session!)).Success);
        Assert.Equal(1, endpoint.RefreshCallCount);
    }

    [Fact]
    public async Task TransientFailureOnRestoreRetriesWithBackoffThenSucceeds()
    {
        var clock = new FakeClock();
        var endpoint = new RotationAwareEndpoint(clock, "refresh-0");
        endpoint.ScriptedResults.Enqueue(TokenRefreshResult.Transient("network error (HttpRequestException)"));
        endpoint.ScriptedResults.Enqueue(TokenRefreshResult.Transient("HTTP 503"));
        var delays = new List<TimeSpan>();
        var store = new FakeSessionStore(new PersistedSession("stale", "refresh-0", clock.Now.AddDays(-2)));
        var keeper = CreateKeeper(store, endpoint, clock, delays);

        var result = await keeper.RestoreAsync(store.Session!);

        Assert.True(result.Success);
        Assert.Equal(3, endpoint.RefreshCallCount);
        Assert.Equal(SessionKeeper.DefaultRestoreRetryDelays, delays);
        Assert.Equal(0, store.DeleteCallCount);
        // The same (never-spent) token was presented every time.
        Assert.All(endpoint.PresentedRefreshTokens, token => Assert.Equal("refresh-0", token));
    }

    [Fact]
    public async Task TransientFailureThatOutlastsTheRetriesKeepsTheStoredSessionAndIsNotAnInvalidSession()
    {
        var clock = new FakeClock();
        var endpoint = new RotationAwareEndpoint(clock, "refresh-0");
        for (var i = 0; i < 5; i++)
        {
            endpoint.ScriptedResults.Enqueue(TokenRefreshResult.Transient("network error (HttpRequestException)"));
        }

        var original = new PersistedSession("stale", "refresh-0", clock.Now.AddDays(-2));
        var store = new FakeSessionStore(original);
        var keeper = CreateKeeper(store, endpoint, clock);

        var result = await keeper.RestoreAsync(original);

        Assert.False(result.Success);
        Assert.True(result.IsTransient);
        Assert.Equal(3, endpoint.RefreshCallCount); // 1 try + 2 retries
        Assert.Equal(0, store.DeleteCallCount);
        Assert.Same(original, store.Session); // untouched
        Assert.False(keeper.HasSession); // never claims a stale token is a live session
    }

    [Fact]
    public async Task DefinitiveRejectionOnRestoreClearsTheStoredSession()
    {
        var clock = new FakeClock();
        var endpoint = new RotationAwareEndpoint(clock, "some-other-token"); // stored token is dead
        var store = new FakeSessionStore(new PersistedSession("stale", "refresh-0", clock.Now.AddDays(-2)));
        var keeper = CreateKeeper(store, endpoint, clock);

        var result = await keeper.RestoreAsync(store.Session!);

        Assert.False(result.Success);
        Assert.False(result.IsTransient);
        Assert.Equal(1, endpoint.RefreshCallCount); // not retried — retrying a dead token is pointless
        Assert.Equal(1, store.DeleteCallCount);
        Assert.Null(store.Session);
        Assert.False(keeper.HasSession);
    }

    [Fact]
    public async Task RestoreAfterTheNinetyDayCeilingRequiresAFreshSignInWithoutCallingTheNetwork()
    {
        var clock = new FakeClock();
        var endpoint = new RotationAwareEndpoint(clock, "refresh-0");
        var store = new FakeSessionStore(new PersistedSession(FakeJwt(clock.Now.AddMinutes(30)), "refresh-0", clock.Now.AddDays(-90).AddMinutes(-1)));
        var keeper = CreateKeeper(store, endpoint, clock);

        var result = await keeper.RestoreAsync(store.Session!);

        Assert.False(result.Success);
        Assert.False(result.IsTransient);
        Assert.Equal(0, endpoint.RefreshCallCount);
        Assert.Equal(1, store.DeleteCallCount);
    }

    [Fact]
    public async Task RestoreJustInsideTheNinetyDayCeilingStillWorks()
    {
        var clock = new FakeClock();
        var endpoint = new RotationAwareEndpoint(clock, "refresh-0");
        var store = new FakeSessionStore(new PersistedSession("stale", "refresh-0", clock.Now.AddDays(-89)));
        var keeper = CreateKeeper(store, endpoint, clock);

        Assert.True((await keeper.RestoreAsync(store.Session!)).Success);
    }

    // ---- Refresh while running / rotation ---------------------------

    [Fact]
    public async Task ConcurrentCallersShareExactlyOneRefresh()
    {
        var clock = new FakeClock();
        var endpoint = new RotationAwareEndpoint(clock, "refresh-0") { Gate = new TaskCompletionSource<bool>() };
        var store = new FakeSessionStore();
        var keeper = CreateKeeper(store, endpoint, clock);
        keeper.StartInteractiveSession(FakeJwt(clock.Now.AddMinutes(2)), "refresh-0"); // inside the refresh skew

        var callers = Enumerable.Range(0, 12).Select(_ => keeper.GetValidAccessTokenAsync()).ToArray();
        await Task.Delay(50); // let every caller reach the gate
        endpoint.Gate!.SetResult(true);
        var tokens = await Task.WhenAll(callers);

        Assert.Equal(1, endpoint.RefreshCallCount); // not 12 — a second use of refresh-0 would be reuse
        Assert.Single(tokens.Distinct());
        Assert.Equal(keeper.AccessToken, tokens[0]);
        Assert.Equal("refresh-1", store.LastSaved!.RefreshToken);
    }

    [Fact]
    public async Task EveryRotationIsPersistedSoARestartAfterBackgroundRefreshesStillWorks()
    {
        // The root-cause scenario: app runs for hours (several rotations),
        // is then restarted. The old code left the FIRST refresh token on
        // disk; GoTrue then rejects it as already used.
        var clock = new FakeClock();
        var endpoint = new RotationAwareEndpoint(clock, "refresh-0");
        var store = new FakeSessionStore();
        var running = CreateKeeper(store, endpoint, clock);
        running.StartInteractiveSession(endpoint.IssueAccessToken(), "refresh-0");

        for (var hour = 1; hour <= 5; hour++)
        {
            clock.Now = clock.Now.AddMinutes(56);
            await running.GetValidAccessTokenAsync();
        }

        Assert.Equal(5, endpoint.RefreshCallCount);
        Assert.Equal(endpoint.ValidRefreshToken, store.Session!.RefreshToken); // disk == the live token

        // "Restart" after the access token has expired: a brand-new
        // keeper restores from what is on disk and must refresh with the
        // LATEST token (disk == live token), not an already-spent one.
        clock.Now = clock.Now.AddMinutes(70);
        var restarted = CreateKeeper(store, endpoint, clock);
        var result = await restarted.RestoreAsync(store.Session!);

        Assert.True(result.Success);
        Assert.True(restarted.HasSession);
        Assert.Equal(6, endpoint.RefreshCallCount);
        Assert.Equal(endpoint.ValidRefreshToken, store.Session!.RefreshToken);
    }

    [Fact]
    public async Task ARefreshedAccessTokenRaisesTheEventOnceAfterItIsPersisted()
    {
        var clock = new FakeClock();
        var endpoint = new RotationAwareEndpoint(clock, "refresh-0");
        var store = new FakeSessionStore();
        var keeper = CreateKeeper(store, endpoint, clock);
        keeper.StartInteractiveSession(FakeJwt(clock.Now.AddMinutes(1)), "refresh-0");

        var raised = new List<string>();
        var savedWhenRaised = -1;
        keeper.AccessTokenRefreshed += (_, token) =>
        {
            raised.Add(token);
            savedWhenRaised = store.SaveCallCount;
        };

        await keeper.GetValidAccessTokenAsync();
        await keeper.GetValidAccessTokenAsync(); // now fresh — no second refresh

        Assert.Equal(new[] { keeper.AccessToken! }, raised);
        Assert.Equal(2, savedWhenRaised); // sign-in save + the rotated save, both before the event
        Assert.Equal(1, endpoint.RefreshCallCount);
    }

    [Fact]
    public async Task AFreshAccessTokenIsReturnedAsIsWithoutRefreshing()
    {
        var clock = new FakeClock();
        var endpoint = new RotationAwareEndpoint(clock, "refresh-0");
        var keeper = CreateKeeper(new FakeSessionStore(), endpoint, clock);
        var access = FakeJwt(clock.Now.AddMinutes(40));
        keeper.StartInteractiveSession(access, "refresh-0");

        Assert.Equal(access, await keeper.GetValidAccessTokenAsync());
        Assert.Equal(0, endpoint.RefreshCallCount);
    }

    [Fact]
    public async Task TransientRefreshFailureWhileRunningKeepsTheSessionAndTheStoredToken()
    {
        var clock = new FakeClock();
        var endpoint = new RotationAwareEndpoint(clock, "refresh-0");
        endpoint.ScriptedResults.Enqueue(TokenRefreshResult.Transient("HTTP 503"));
        var store = new FakeSessionStore();
        var keeper = CreateKeeper(store, endpoint, clock);
        var access = FakeJwt(clock.Now.AddMinutes(1));
        keeper.StartInteractiveSession(access, "refresh-0");

        var token = await keeper.GetValidAccessTokenAsync();

        Assert.Equal(access, token); // unchanged; the next tick retries
        Assert.True(keeper.HasSession);
        Assert.Equal(0, store.DeleteCallCount);
        Assert.Equal("refresh-0", store.Session!.RefreshToken);

        // ...and the retry works, with the same never-spent token.
        Assert.NotEqual(access, await keeper.GetValidAccessTokenAsync());
    }

    [Fact]
    public async Task RejectedRefreshWhileRunningEndsTheSessionAndClearsTheStore()
    {
        var clock = new FakeClock();
        var endpoint = new RotationAwareEndpoint(clock, "refresh-0");
        endpoint.ScriptedResults.Enqueue(TokenRefreshResult.Rejected("HTTP 400 (session_not_found)"));
        var store = new FakeSessionStore();
        var keeper = CreateKeeper(store, endpoint, clock);
        keeper.StartInteractiveSession(FakeJwt(clock.Now.AddMinutes(1)), "refresh-0");

        Assert.Null(await keeper.GetValidAccessTokenAsync());
        Assert.False(keeper.HasSession);
        Assert.Null(store.Session);
    }

    [Fact]
    public async Task TheNinetyDayCeilingAlsoEndsALongRunningSession()
    {
        var clock = new FakeClock();
        var endpoint = new RotationAwareEndpoint(clock, "refresh-0");
        var store = new FakeSessionStore();
        var keeper = CreateKeeper(store, endpoint, clock);
        keeper.StartInteractiveSession(endpoint.IssueAccessToken(), "refresh-0");

        clock.Now = clock.Now.AddDays(90).AddMinutes(1);

        Assert.Null(await keeper.GetValidAccessTokenAsync());
        Assert.Equal(0, endpoint.RefreshCallCount);
        Assert.Null(store.Session);
    }

    [Fact]
    public async Task NoSessionMeansNoTokenAndNoNetworkCall()
    {
        var clock = new FakeClock();
        var endpoint = new RotationAwareEndpoint(clock, "refresh-0");
        var keeper = CreateKeeper(new FakeSessionStore(), endpoint, clock);

        Assert.Null(await keeper.GetValidAccessTokenAsync());
        Assert.Equal(0, endpoint.RefreshCallCount);
    }

    // ---- Persistence details ----------------------------------------

    [Fact]
    public void InteractiveSignInStartsANewNinetyDayWindowAndPersistsIt()
    {
        var clock = new FakeClock();
        var store = new FakeSessionStore();
        var keeper = CreateKeeper(store, new RotationAwareEndpoint(clock, "x"), clock);

        keeper.StartInteractiveSession("access", "refresh-0");

        Assert.Equal("access", store.LastSaved!.AccessToken);
        Assert.Equal("refresh-0", store.LastSaved.RefreshToken);
        Assert.Equal(clock.Now, store.LastSaved.IssuedAtUtc);
    }

    [Fact]
    public async Task AFailedSaveIsRetriedOnceAndNeverCrashesTheRefresh()
    {
        var clock = new FakeClock();
        var endpoint = new RotationAwareEndpoint(clock, "refresh-0");
        var store = new FlakySessionStore(failuresBeforeSuccess: 1);
        var keeper = new SessionKeeper(store, endpoint, () => clock.Now, (_, _) => Task.CompletedTask);
        keeper.StartInteractiveSession("not-a-jwt", "refresh-0"); // first save fails, retry succeeds

        Assert.Equal("refresh-0", store.Session!.RefreshToken);

        await keeper.GetValidAccessTokenAsync(); // refresh -> save OK
        Assert.Equal("refresh-1", store.Session!.RefreshToken);
    }

    [Fact]
    public async Task AnotherAppInstanceThatAlreadyRotatedTheTokenIsAdoptedInsteadOfReusingASpentOne()
    {
        var clock = new FakeClock();
        var endpoint = new RotationAwareEndpoint(clock, "refresh-9"); // only refresh-9 is valid now
        var store = new FakeSessionStore();
        var keeper = CreateKeeper(store, endpoint, clock);
        keeper.StartInteractiveSession(FakeJwt(clock.Now.AddMinutes(1)), "refresh-0");

        // Second instance rotated and saved while we were idle.
        store.Save(new PersistedSession(FakeJwt(clock.Now.AddMinutes(1)), "refresh-9", clock.Now));

        var token = await keeper.GetValidAccessTokenAsync();

        Assert.Equal("refresh-9", endpoint.PresentedRefreshTokens.Single());
        Assert.NotNull(token);
        Assert.True(keeper.HasSession);
    }

    // ---- Sign-out ----------------------------------------------------

    [Fact]
    public async Task SignOutClearsMemoryAndTheStoreAndEndsOnlyThisSessionOnTheServer()
    {
        var clock = new FakeClock();
        var endpoint = new RotationAwareEndpoint(clock, "refresh-0");
        var store = new FakeSessionStore();
        var keeper = CreateKeeper(store, endpoint, clock);
        var access = FakeJwt(clock.Now.AddMinutes(30));
        keeper.StartInteractiveSession(access, "refresh-0");

        await keeper.SignOutAsync();

        Assert.False(keeper.HasSession);
        Assert.Null(keeper.RefreshToken);
        Assert.Null(store.Session);
        Assert.Equal(new[] { access }, endpoint.LoggedOutAccessTokens);
        Assert.Null(await keeper.GetValidAccessTokenAsync());
    }

    [Fact]
    public async Task TokensNeverAppearInLogLines()
    {
        var clock = new FakeClock();
        var endpoint = new RotationAwareEndpoint(clock, "refresh-0");
        endpoint.ScriptedResults.Enqueue(TokenRefreshResult.Transient("HTTP 503"));
        var log = new List<string>();
        var store = new FakeSessionStore();
        var keeper = CreateKeeper(store, endpoint, clock, log: log);
        var access = FakeJwt(clock.Now.AddMinutes(1));
        keeper.StartInteractiveSession(access, "refresh-secret-value");

        await keeper.GetValidAccessTokenAsync();
        await keeper.GetValidAccessTokenAsync();
        await keeper.SignOutAsync();

        Assert.NotEmpty(log);
        Assert.DoesNotContain(log, line => line.Contains("refresh-secret-value") || line.Contains(access));
    }

    // ---- Review round: clock skew, storms, forced refresh, SessionEnded, sign-out race

    [Fact]
    public async Task ClockSteppedBackKeepsTheSessionAndReAnchorsTheCeilingToNow()
    {
        var clock = new FakeClock();
        var endpoint = new RotationAwareEndpoint(clock, "refresh-0");
        var futureAnchor = clock.Now.AddDays(3); // negative age
        var store = new FakeSessionStore(new PersistedSession("stale", "refresh-0", futureAnchor));
        var keeper = CreateKeeper(store, endpoint, clock);

        var result = await keeper.RestoreAsync(store.Session!);

        Assert.True(result.Success);
        Assert.Equal(0, store.DeleteCallCount);
        Assert.Equal(clock.Now, store.LastSaved!.IssuedAtUtc); // clamped: can't stretch the 90 days
    }

    [Fact]
    public async Task ClockSteppedBackWhileRunningDoesNotEndTheSession()
    {
        var clock = new FakeClock();
        var endpoint = new RotationAwareEndpoint(clock, "refresh-0");
        var store = new FakeSessionStore();
        var keeper = CreateKeeper(store, endpoint, clock);
        keeper.StartInteractiveSession(FakeJwt(T0.AddDays(-3)), "refresh-0"); // issued at T0, token already stale

        clock.Now = T0.AddDays(-2); // clock stepped back: the session is "from the future" (negative age)

        var token = await keeper.GetValidAccessTokenAsync();

        Assert.Equal(1, endpoint.RefreshCallCount); // refreshed normally...
        Assert.NotNull(token);
        Assert.True(keeper.HasSession); // ...and the session survived
        Assert.Equal(0, store.DeleteCallCount);
    }

    [Fact]
    public async Task ClockFarAheadDoesNotCauseARefreshStorm()
    {
        var clock = new FakeClock();
        var endpoint = new RotationAwareEndpoint(clock, "refresh-0") { FixedExpiry = T0.AddHours(1) };
        var keeper = CreateKeeper(new FakeSessionStore(), endpoint, clock);
        keeper.StartInteractiveSession(endpoint.IssueAccessToken(), "refresh-0");
        clock.Now = T0.AddHours(5); // every token (exp T0+1h) already looks expired

        for (var tick = 0; tick < 5; tick++)
        {
            await keeper.GetValidAccessTokenAsync();
            clock.Now = clock.Now.AddSeconds(10);
        }

        Assert.Equal(1, endpoint.RefreshCallCount); // not once per tick

        clock.Now = clock.Now.AddSeconds(SessionKeeper.MinRefreshInterval.TotalSeconds);
        await keeper.GetValidAccessTokenAsync();
        Assert.Equal(2, endpoint.RefreshCallCount); // allowed again after the interval
    }

    [Fact]
    public async Task RefreshAfterUnauthorizedRefreshesOnceEvenWhenTheTokenLooksValid()
    {
        var clock = new FakeClock();
        var endpoint = new RotationAwareEndpoint(clock, "refresh-0");
        var store = new FakeSessionStore();
        var keeper = CreateKeeper(store, endpoint, clock);
        var rejected = FakeJwt(clock.Now.AddMinutes(40));
        keeper.StartInteractiveSession(rejected, "refresh-0");

        var retryToken = await keeper.RefreshAfterUnauthorizedAsync(rejected);

        Assert.Equal(1, endpoint.RefreshCallCount);
        Assert.NotEqual(rejected, retryToken);
        Assert.Equal("refresh-1", store.Session!.RefreshToken);

        // Same stale token reported again (a second in-flight request that
        // also got 401): already replaced -> no second refresh.
        await keeper.RefreshAfterUnauthorizedAsync(rejected);
        Assert.Equal(1, endpoint.RefreshCallCount);

        // The NEW token also 401s: rate-limited, no storm.
        await keeper.RefreshAfterUnauthorizedAsync(retryToken!);
        Assert.Equal(1, endpoint.RefreshCallCount);
    }

    [Fact]
    public async Task RefreshAfterUnauthorizedWithNoSessionDoesNothing()
    {
        var clock = new FakeClock();
        var endpoint = new RotationAwareEndpoint(clock, "refresh-0");
        var keeper = CreateKeeper(new FakeSessionStore(), endpoint, clock);

        Assert.Null(await keeper.RefreshAfterUnauthorizedAsync("whatever"));
        Assert.Equal(0, endpoint.RefreshCallCount);
    }

    [Fact]
    public async Task SessionEndedIsRaisedOnceWhenARunningSessionIsRejected()
    {
        var clock = new FakeClock();
        var endpoint = new RotationAwareEndpoint(clock, "refresh-0");
        endpoint.ScriptedResults.Enqueue(TokenRefreshResult.Rejected("HTTP 400 (session_not_found)"));
        var store = new FakeSessionStore();
        var keeper = CreateKeeper(store, endpoint, clock);
        keeper.StartInteractiveSession(FakeJwt(clock.Now.AddMinutes(1)), "refresh-0");
        var reasons = new List<string>();
        keeper.SessionEnded += (_, reason) => reasons.Add(reason);

        await keeper.GetValidAccessTokenAsync();
        await keeper.GetValidAccessTokenAsync(); // no session any more: nothing more raised

        Assert.Single(reasons);
        Assert.Contains("session_not_found", reasons[0]);
        Assert.Null(store.Session); // already cleared when the event fires
    }

    [Fact]
    public async Task SessionEndedIsRaisedWhenTheNinetyDayCeilingEndsARunningSession()
    {
        var clock = new FakeClock();
        var endpoint = new RotationAwareEndpoint(clock, "refresh-0");
        var keeper = CreateKeeper(new FakeSessionStore(), endpoint, clock);
        keeper.StartInteractiveSession(endpoint.IssueAccessToken(), "refresh-0");
        var raised = 0;
        keeper.SessionEnded += (_, _) => raised++;

        clock.Now = clock.Now.AddDays(91);
        await keeper.GetValidAccessTokenAsync();

        Assert.Equal(1, raised);
    }

    [Fact]
    public async Task SessionEndedIsNotRaisedForStartupRestoreFailuresOrSignOut()
    {
        var clock = new FakeClock();
        var endpoint = new RotationAwareEndpoint(clock, "some-other-token"); // stored token is dead
        var store = new FakeSessionStore(new PersistedSession("stale", "refresh-0", clock.Now.AddDays(-2)));
        var keeper = CreateKeeper(store, endpoint, clock);
        var raised = 0;
        keeper.SessionEnded += (_, _) => raised++;

        Assert.False((await keeper.RestoreAsync(store.Session!)).Success); // caller shows sign-in itself

        keeper.StartInteractiveSession(FakeJwt(clock.Now.AddMinutes(30)), "refresh-1");
        await keeper.SignOutAsync();

        Assert.Equal(0, raised);
    }

    [Fact]
    public async Task SignOutWaitsForAnInFlightRefreshSoItCanNeverRewriteSessionJsonAfterwards()
    {
        var clock = new FakeClock();
        var endpoint = new RotationAwareEndpoint(clock, "refresh-0") { Gate = new TaskCompletionSource<bool>() };
        var store = new FakeSessionStore();
        var keeper = CreateKeeper(store, endpoint, clock);
        keeper.StartInteractiveSession(FakeJwt(clock.Now.AddMinutes(1)), "refresh-0");

        var refresh = keeper.GetValidAccessTokenAsync(); // blocked at the endpoint
        var signOut = keeper.SignOutAsync();
        await Task.Delay(50);
        Assert.False(signOut.IsCompleted); // sign-out is queued behind the refresh

        endpoint.Gate!.SetResult(true);
        await Task.WhenAll(refresh, signOut);

        Assert.Null(store.Session); // the refresh's save did NOT survive the sign-out
        Assert.False(keeper.HasSession);
        Assert.Null(keeper.RefreshToken);
    }

    [Fact]
    public async Task ARefreshQueuedBehindSignOutDoesNotResurrectTheSession()
    {
        var clock = new FakeClock();
        var endpoint = new RotationAwareEndpoint(clock, "refresh-0");
        var store = new FakeSessionStore();
        var keeper = CreateKeeper(store, endpoint, clock);
        keeper.StartInteractiveSession(FakeJwt(clock.Now.AddMinutes(1)), "refresh-0");

        await keeper.SignOutAsync();
        await keeper.GetValidAccessTokenAsync();

        Assert.Equal(0, endpoint.RefreshCallCount);
        Assert.Null(store.Session);
    }

    private sealed class FlakySessionStore : ISessionStore
    {
        private int _failuresLeft;

        public FlakySessionStore(int failuresBeforeSuccess)
        {
            _failuresLeft = failuresBeforeSuccess;
        }

        public PersistedSession? Session { get; private set; }

        public PersistedSession? Load() => Session;

        public void Save(PersistedSession session)
        {
            if (_failuresLeft-- > 0)
            {
                throw new System.IO.IOException("disk busy");
            }

            Session = session;
        }

        public void Delete() => Session = null;
    }
}
