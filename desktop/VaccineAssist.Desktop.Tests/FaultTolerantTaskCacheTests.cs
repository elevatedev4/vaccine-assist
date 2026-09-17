using System;
using System.Threading.Tasks;
using VaccineAssist.Desktop.Services;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// Unit tests for FaultTolerantTaskCache.GetOrCreate — the pure
/// get-or-create-unless-faulted policy behind
/// SharedCloudWebView2Environment.GetAsync (Will, 2026-09-16: "if the
/// cached environment task faulted, drop it so the next GetAsync
/// retries"). Exercised with plain int tasks rather than
/// CoreWebView2Environment since the real environment creation needs the
/// actual WebView2 Evergreen runtime installed and can't run in a unit
/// test.
/// </summary>
public class FaultTolerantTaskCacheTests
{
    [Fact]
    public void CreatesWhenNoCachedTaskExists()
    {
        var factoryCalls = 0;
        var result = FaultTolerantTaskCache.GetOrCreate<int>(null, () =>
        {
            factoryCalls++;
            return Task.FromResult(1);
        });

        Assert.Equal(1, factoryCalls);
        Assert.Equal(1, result.Result);
    }

    [Fact]
    public void ReusesACompletedSuccessfulTaskWithoutCallingFactory()
    {
        var cached = Task.FromResult(42);
        var factoryCalls = 0;

        var result = FaultTolerantTaskCache.GetOrCreate(cached, () =>
        {
            factoryCalls++;
            return Task.FromResult(99);
        });

        Assert.Equal(0, factoryCalls);
        Assert.Same(cached, result);
    }

    [Fact]
    public void ReusesAStillPendingTaskWithoutCallingFactory()
    {
        var pending = new TaskCompletionSource<int>();
        var factoryCalls = 0;

        var result = FaultTolerantTaskCache.GetOrCreate(pending.Task, () =>
        {
            factoryCalls++;
            return Task.FromResult(99);
        });

        Assert.Equal(0, factoryCalls);
        Assert.Same(pending.Task, result);
    }

    [Fact]
    public void DropsAFaultedCachedTaskAndCreatesAFreshOne()
    {
        var faulted = Task.FromException<int>(new InvalidOperationException("boom"));
        var factoryCalls = 0;

        var result = FaultTolerantTaskCache.GetOrCreate(faulted, () =>
        {
            factoryCalls++;
            return Task.FromResult(7);
        });

        Assert.Equal(1, factoryCalls);
        Assert.NotSame(faulted, result);
        Assert.Equal(7, result.Result);
    }

    [Fact]
    public void SimulatesGetAsyncRetryAfterAPermanentFailure()
    {
        // Mirrors how SharedCloudWebView2Environment.GetAsync uses this:
        // storing the returned task back into a field and calling again.
        Task<int>? cache = null;
        var attempt = 0;

        Task<int> Factory()
        {
            attempt++;
            return attempt == 1
                ? Task.FromException<int>(new InvalidOperationException("first attempt fails"))
                : Task.FromResult(123);
        }

        cache = FaultTolerantTaskCache.GetOrCreate(cache, Factory);
        Assert.True(cache.IsFaulted);

        // A later caller should get a fresh, successful attempt instead of
        // the same dead task forever.
        cache = FaultTolerantTaskCache.GetOrCreate(cache, Factory);
        Assert.Equal(2, attempt);
        Assert.Equal(123, cache.Result);
    }
}
