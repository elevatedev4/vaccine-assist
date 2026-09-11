using System;
using System.Runtime.InteropServices;
using FlaUI.Core.Exceptions;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// V-T28 (Will, 2026-09-09): "Made it to the start of data entry into
/// Pioneer, then error: Unexpected error during auto-watch: Operation
/// timed out. (0x80131505)" — AutoWatchErrorClassifier.IsRecoverable is the
/// pure decision behind treating that failure as a RECOVERABLE "still
/// waiting" condition (retried by AutoWatchRetry) instead of an immediate
/// hard failure. Pure/no-UIA-dependency, same "logic extracted as a public
/// static method for testability" pattern as
/// Uia/UiaTreeDumper.TruncateValue and Uia/PioneerRxPresenceDecision.
/// </summary>
public class AutoWatchErrorClassifierTests
{
    [Fact]
    public void PlainTimeoutExceptionIsRecoverable()
    {
        // The EXACT shape from Will's report: a bare `new TimeoutException()`
        // defaults to HResult 0x80131505 (COR_E_TIMEOUT) and Message
        // "Operation timed out.".
        Assert.True(AutoWatchErrorClassifier.IsRecoverable(new TimeoutException()));
    }

    [Fact]
    public void ComExceptionWithCorETimeoutHResultIsRecoverable()
    {
        var ex = new COMException("The message filter indicated that the application is busy.", unchecked((int)0x80131505));
        Assert.True(AutoWatchErrorClassifier.IsRecoverable(ex));
    }

    [Fact]
    public void ComExceptionWithRpcETimeoutHResultIsRecoverable()
    {
        var ex = new COMException("Call did not complete in time.", unchecked((int)0x8001010F));
        Assert.True(AutoWatchErrorClassifier.IsRecoverable(ex));
    }

    [Fact]
    public void ComExceptionWithRpcEServerCallRetryLaterHResultIsRecoverable()
    {
        var ex = new COMException("The application is busy processing another call.", unchecked((int)0x8001010A));
        Assert.True(AutoWatchErrorClassifier.IsRecoverable(ex));
    }

    [Fact]
    public void ExceptionWhoseMessageSaysTimedOutIsRecoverableEvenWithoutAKnownHResult()
    {
        // Belt-and-suspenders path — see class doc comment: some COM
        // interop wraps a timeout in a plain Exception with an unrelated
        // HResult but a message that still reads like Will's report.
        var ex = new InvalidOperationException("The wait operation timed out.");
        Assert.True(AutoWatchErrorClassifier.IsRecoverable(ex));
    }

    [Fact]
    public void ElementNotEnabledExceptionIsRecoverable()
    {
        // V-..., 2026-09-11 (owner's log, 17:15, build 7ab6500): the
        // prescriber field ('uxPrescriberQuickSearch') existed 416ms after
        // F3 but FocusNative/SetValue threw this because PioneerRx hadn't
        // finished enabling it yet. Treated as recoverable so a field that
        // flips disabled again between WaitForFieldAsync's check and the
        // actual SetValue keeps retrying within AutoWatchRetry's budget
        // instead of failing loud on a one-tick race.
        Assert.True(AutoWatchErrorClassifier.IsRecoverable(new ElementNotEnabledException()));
    }

    [Fact]
    public void RecoverableInnerExceptionMakesTheOuterExceptionRecoverableToo()
    {
        var outer = new InvalidOperationException("Failed to enter the lot number.", new TimeoutException());
        Assert.True(AutoWatchErrorClassifier.IsRecoverable(outer));
    }

    [Fact]
    public void FieldNotFoundIsNotRecoverable()
    {
        // A genuinely-missing field/control is never going to un-happen —
        // retrying it for the full budget would just waste the whole 60s
        // on a failure that was never transient.
        Assert.False(AutoWatchErrorClassifier.IsRecoverable(
            new InvalidOperationException("Couldn't find the lot number field.")));
    }

    [Fact]
    public void UnrelatedComExceptionIsNotRecoverable()
    {
        var ex = new COMException("Element not available.", unchecked((int)0x80040201));
        Assert.False(AutoWatchErrorClassifier.IsRecoverable(ex));
    }

    [Fact]
    public void NullExceptionIsNotRecoverable()
    {
        Assert.False(AutoWatchErrorClassifier.IsRecoverable(null));
    }
}
