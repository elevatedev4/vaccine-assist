using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Threading.Tasks;

namespace VaccineAssist.Desktop.Versioning;

/// <summary>
/// Remote testing branches, looked up with `git ls-remote` from the primary
/// checkout on a background thread (never the UI thread). Result is cached
/// briefly; concurrent refreshes share one lookup. Any failure (git missing,
/// offline, timeout) becomes Unavailable — never an exception to the caller.
/// </summary>
public sealed class TestingVersionCatalog
{
    private readonly Func<CancellationToken, Task<string?>> _lister;
    private readonly TimeSpan _ttl;
    private readonly Func<DateTime> _utcNow;
    private readonly object _gate = new();

    private TestingVersionsSnapshot _snapshot = TestingVersionsSnapshot.Loading;
    private DateTime _loadedAtUtc = DateTime.MinValue;
    private Task<TestingVersionsSnapshot>? _inflight;

    /// <param name="lister">Returns raw ls-remote stdout, or null on any failure.</param>
    public TestingVersionCatalog(Func<CancellationToken, Task<string?>> lister, TimeSpan? ttl = null, Func<DateTime>? utcNow = null)
    {
        _lister = lister ?? throw new ArgumentNullException(nameof(lister));
        _ttl = ttl ?? TimeSpan.FromSeconds(60);
        _utcNow = utcNow ?? (() => DateTime.UtcNow);
    }

    /// <summary>Latest known answer; never blocks.</summary>
    public TestingVersionsSnapshot Snapshot
    {
        get { lock (_gate) { return _snapshot; } }
    }

    /// <summary>Starts (or joins) a lookup unless the cached answer is still fresh.</summary>
    public Task<TestingVersionsSnapshot> RefreshAsync()
    {
        lock (_gate)
        {
            if (_inflight is not null)
            {
                return _inflight;
            }
            if (_snapshot.Status == TestingVersionsStatus.Loaded && _utcNow() - _loadedAtUtc < _ttl)
            {
                return Task.FromResult(_snapshot);
            }
            _inflight = Task.Run(LookupAsync);
            return _inflight;
        }
    }

    private async Task<TestingVersionsSnapshot> LookupAsync()
    {
        TestingVersionsSnapshot result;
        try
        {
            using var cts = new CancellationTokenSource(GitRemoteLister.Timeout);
            var output = await _lister(cts.Token).ConfigureAwait(false);
            result = output is null
                ? TestingVersionsSnapshot.Unavailable
                : new TestingVersionsSnapshot(TestingVersionsStatus.Loaded, TestingBranchParser.ParseLsRemote(output));
        }
        catch
        {
            result = TestingVersionsSnapshot.Unavailable;
        }

        lock (_gate)
        {
            _snapshot = result;
            _loadedAtUtc = _utcNow();
            _inflight = null;
        }
        return result;
    }
}

/// <summary>The real `git ls-remote` call.</summary>
public static class GitRemoteLister
{
    public static readonly TimeSpan Timeout = TimeSpan.FromSeconds(8);

    /// <summary>Arguments after "git", as an ArgumentList (no shell, no quoting issues).</summary>
    public static IReadOnlyList<string> BuildArguments(string primaryRoot) =>
        new[] { "-C", primaryRoot, "ls-remote", "--heads", "origin", "refs/heads/testing/*" };

    /// <summary>Returns stdout on exit code 0, otherwise null (git missing, offline, timeout, error).</summary>
    public static async Task<string?> RunAsync(string? primaryRoot, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(primaryRoot) || !Directory.Exists(primaryRoot))
        {
            return null;
        }

        try
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = "git",
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            foreach (var arg in BuildArguments(primaryRoot))
            {
                startInfo.ArgumentList.Add(arg);
            }
            // Never let git (or Git Credential Manager's GUI login) block
            // waiting for a credentials prompt - a menu lookup must not
            // pop a sign-in window.
            startInfo.Environment["GIT_TERMINAL_PROMPT"] = "0";
            startInfo.Environment["GCM_INTERACTIVE"] = "never";

            using var process = Process.Start(startInfo);
            if (process is null) return null;

            var stdoutTask = process.StandardOutput.ReadToEndAsync();
            var stderrTask = process.StandardError.ReadToEndAsync();
            try
            {
                await process.WaitForExitAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                try { process.Kill(entireProcessTree: true); } catch { /* already gone */ }
                return null;
            }

            var stdout = await stdoutTask.ConfigureAwait(false);
            await stderrTask.ConfigureAwait(false);
            return process.ExitCode == 0 ? stdout : null;
        }
        catch
        {
            return null; // git not installed / not startable
        }
    }
}
