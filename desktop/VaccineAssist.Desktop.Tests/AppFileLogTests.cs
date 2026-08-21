using System;
using VaccineAssist.Desktop.Logging;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// AppFileLog backs both the global crash handlers (App.xaml.cs) and the
/// data-entry popup's "Copy logs" button (V-T3 item 4, Will 2026-08-19/20:
/// "make a way to copy those logs to send to you"). Writes to a real file
/// under %AppData%\VaccineAssist\logs — these tests exercise the actual
/// file I/O (no fake/abstraction layer exists for it, matching this
/// class's own "must never throw" contract: there's nothing to inject
/// around a static logger that's explicitly designed not to need one).
/// </summary>
public class AppFileLogTests
{
    [Fact]
    public void LogThenReadRecentLinesRoundTripsTheMessage()
    {
        var marker = $"test-marker-{Guid.NewGuid()}";

        AppFileLog.Log(marker);
        var recent = AppFileLog.ReadRecentLines();

        Assert.Contains(marker, recent);
    }

    [Fact]
    public void LogExceptionIncludesTypeAndMessage()
    {
        var marker = $"test-marker-{Guid.NewGuid()}";
        var ex = new InvalidOperationException($"boom {marker}");

        AppFileLog.LogException("UnitTest", ex);
        var recent = AppFileLog.ReadRecentLines();

        Assert.Contains("InvalidOperationException", recent);
        Assert.Contains(marker, recent);
        Assert.Contains("[UnitTest]", recent);
    }

    [Fact]
    public void ReadRecentLinesNeverThrowsEvenBeforeAnyLogCall()
    {
        // Can't guarantee a truly pristine (never-written) log file inside
        // a shared test-run environment, so this just asserts the "never
        // throws" contract directly rather than the file's prior state.
        var exception = Record.Exception(() => AppFileLog.ReadRecentLines());

        Assert.Null(exception);
    }
}
