using System;
using System.Threading.Tasks;

namespace VaccineAssist.Desktop.Services;

/// <summary>
/// Pure "get-or-create, but never cache a permanent failure" policy behind
/// SharedCloudWebView2Environment.GetAsync — extracted so the
/// retry-after-fault behavior is unit-testable without touching WebView2
/// itself (SharedCloudWebView2Environment.CreateAsync calls the real
/// CoreWebView2Environment.CreateAsync, which needs the actual Evergreen
/// runtime installed and can't run in a unit test).
///
/// TIMEOUT FIX (Will, 2026-09-16): before this, a single failed
/// CoreWebView2Environment.CreateAsync call (e.g. a transient failure the
/// very first time the app ever ran) cached its faulted Task forever —
/// every later GetAsync() call (from CloudPageView OR MacroCodesWindow,
/// since they share this one cache) just re-awaited the same dead task and
/// got the same exception again, with no way to ever recover short of
/// restarting the app. Callers that GetOrCreate through here now get a
/// fresh attempt once the cached one has faulted.
/// </summary>
public static class FaultTolerantTaskCache
{
    /// <summary>Returns <paramref name="cached"/> unchanged if it's still
    /// pending or completed successfully; otherwise (null, or faulted)
    /// returns a fresh task from <paramref name="factory"/>. Never
    /// evaluates <paramref name="factory"/> unless a fresh task is
    /// actually needed. The caller is responsible for storing the returned
    /// task back into whatever field it uses as the cache — this method
    /// has no side effects of its own.</summary>
    public static Task<T> GetOrCreate<T>(Task<T>? cached, Func<Task<T>> factory)
    {
        if (cached is null || cached.IsFaulted)
        {
            return factory();
        }

        return cached;
    }
}
