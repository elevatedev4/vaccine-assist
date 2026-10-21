using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Threading;
using VaccineAssist.Desktop.Logging;

namespace VaccineAssist.Desktop.Startup;

/// <summary>Whether another Vaccine Assist process answers window messages.</summary>
public enum InstanceHealth
{
    /// <summary>Its windows answered a probe message in time.</summary>
    Responsive,

    /// <summary>A window did not answer in time (the UI thread is frozen).</summary>
    Hung,

    /// <summary>No window to probe (still starting, or not visible to us).</summary>
    Unknown,
}

/// <summary>Another process running this exe, as seen from a second launch.</summary>
/// <param name="Killable">Same Windows session and same user as this launch - the only processes we may offer to close.</param>
public sealed record OtherInstance(int ProcessId, InstanceHealth Health, bool Killable);

/// <summary>What a launch that did not get the single-instance mutex should do.</summary>
public enum SingleInstanceDecision
{
    /// <summary>The mutex is ours: start normally.</summary>
    RunNormally,

    /// <summary>A healthy instance acknowledged the activation signal: it was focused, this launch exits.</summary>
    ActivatedExisting,

    /// <summary>The instance holding the mutex is frozen: ask before closing it and taking over.</summary>
    OfferRecovery,

    /// <summary>Something holds the mutex that we cannot prove is frozen (or may not close): say so and exit.</summary>
    ShowAlreadyRunning,
}

/// <summary>
/// Pure decision logic for the single-instance mutex (Program.Main). Outage
/// 2026-10-20: a frozen copy kept holding the mutex, so every later launch,
/// including the Stable shortcut, quietly exited ("won't even open") until
/// the stuck tasks were ended by hand. No WPF, no I/O, so it is unit-tested.
/// </summary>
public static class SingleInstancePolicy
{
    public static SingleInstanceDecision Decide(
        bool mutexAcquired,
        bool activationAcknowledged,
        IReadOnlyList<OtherInstance> others)
    {
        if (mutexAcquired)
        {
            return SingleInstanceDecision.RunNormally;
        }

        // A healthy instance that listens for the signal answers from its UI
        // thread, which proves it is alive. Just focus it, as before.
        if (activationAcknowledged)
        {
            return SingleInstanceDecision.ActivatedExisting;
        }

        var hung = others.Where(o => o.Health == InstanceHealth.Hung).ToList();
        var anyResponsive = others.Any(o => o.Health == InstanceHealth.Responsive);

        // Offer to close only when something is provably frozen, nothing else
        // looks alive (a responsive process without the signal listener is an
        // older build that is working), and every frozen one is ours to close.
        if (hung.Count > 0 && !anyResponsive && hung.All(o => o.Killable))
        {
            return SingleInstanceDecision.OfferRecovery;
        }

        return SingleInstanceDecision.ShowAlreadyRunning;
    }

    /// <summary>A process may be closed only if it belongs to this user in this Windows session.</summary>
    public static bool IsKillable(int mySessionId, int otherSessionId, string? mySid, string? otherSid) =>
        mySessionId == otherSessionId
        && !string.IsNullOrEmpty(mySid)
        && string.Equals(mySid, otherSid, StringComparison.OrdinalIgnoreCase);
}

/// <summary>
/// The named events a second launch uses to ask a running instance to come to
/// the front. The running instance answers from its UI thread (Dispatcher),
/// so an answer proves the UI thread is alive. Builds from before this change
/// have no listener: the second launch then falls back to probing windows.
/// </summary>
public static class InstanceSignals
{
    public const string ActivateEventName = "Local\\VaccineAssistDesktop-Activate";
    public const string AckEventName = "Local\\VaccineAssistDesktop-ActivateAck";

    /// <summary>True when a running instance acknowledged within <paramref name="wait"/>. Never throws.</summary>
    public static bool TrySignalExisting(TimeSpan wait)
    {
        try
        {
            using var activate = EventWaitHandle.OpenExisting(ActivateEventName);
            using var ack = EventWaitHandle.OpenExisting(AckEventName);
            ack.Reset();
            activate.Set();
            return ack.WaitOne(wait);
        }
        catch (WaitHandleCannotBeOpenedException)
        {
            AppFileLog.Log("[Startup] no activation listener in the running instance (older build, or it is still starting)");
            return false;
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("InstanceSignals.TrySignalExisting", ex);
            return false;
        }
    }
}

/// <summary>Owned by the running instance: turns a second launch's signal into "activate the main window" on the UI thread, then acknowledges.</summary>
public sealed class ActivationListener : IDisposable
{
    private readonly EventWaitHandle _activate;
    private readonly EventWaitHandle _ack;
    private readonly Action<Action> _postToUiThread;
    private readonly Action _activateWindow;
    private RegisteredWaitHandle? _registration;

    private ActivationListener(EventWaitHandle activate, EventWaitHandle ack, Action<Action> postToUiThread, Action activateWindow)
    {
        _activate = activate;
        _ack = ack;
        _postToUiThread = postToUiThread;
        _activateWindow = activateWindow;
    }

    /// <summary>Null when the events cannot be created (logged); the app then simply has no activation support.</summary>
    public static ActivationListener? TryStart(Action<Action> postToUiThread, Action activateWindow)
    {
        EventWaitHandle? activate = null;
        EventWaitHandle? ack = null;
        try
        {
            activate = new EventWaitHandle(false, EventResetMode.AutoReset, InstanceSignals.ActivateEventName);
            ack = new EventWaitHandle(false, EventResetMode.AutoReset, InstanceSignals.AckEventName);
            var listener = new ActivationListener(activate, ack, postToUiThread, activateWindow);
            listener._registration = ThreadPool.RegisterWaitForSingleObject(
                activate, listener.OnSignaled, null, Timeout.Infinite, false);
            AppFileLog.Log("[Startup] activation listener ready");
            return listener;
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("ActivationListener.TryStart", ex);
            activate?.Dispose();
            ack?.Dispose();
            return null;
        }
    }

    private void OnSignaled(object? state, bool timedOut)
    {
        AppFileLog.Log("[Startup] activation requested by a second launch");
        try
        {
            _postToUiThread(() =>
            {
                try
                {
                    _activateWindow();
                }
                catch (Exception ex)
                {
                    AppFileLog.LogException("ActivationListener.Activate", ex);
                }
                finally
                {
                    try
                    {
                        _ack.Set();
                    }
                    catch (ObjectDisposedException)
                    {
                    }
                }
            });
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("ActivationListener.OnSignaled", ex);
        }
    }

    public void Dispose()
    {
        try
        {
            _registration?.Unregister(null);
        }
        catch (Exception)
        {
        }

        _activate.Dispose();
        _ack.Dispose();
    }
}

/// <summary>Looks at the other processes running this exe (Windows only; every failure is logged and degrades to "Unknown").</summary>
public static class SingleInstanceProbe
{
    private const int WmNull = 0x0000;
    private const uint SmtoBlock = 0x0001;
    private const uint SmtoAbortIfHung = 0x0002;
    private const uint ProbeTimeoutMs = 2000;
    private const uint ProcessQueryLimitedInformation = 0x1000;
    private const uint TokenQuery = 0x0008;

    private delegate bool EnumThreadWndProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumThreadWindows(uint threadId, EnumThreadWndProc callback, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SendMessageTimeoutW(
        IntPtr hwnd, int message, IntPtr wParam, IntPtr lParam, uint flags, uint timeoutMs, out IntPtr result);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, int processId);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr processHandle, uint desiredAccess, out IntPtr tokenHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    /// <summary>Every other process with this exe's name, with health and whether we may close it.</summary>
    public static List<OtherInstance> Probe(out List<Process> processes)
    {
        processes = new List<Process>();
        var result = new List<OtherInstance>();
        try
        {
            using var me = Process.GetCurrentProcess();
            var mySession = me.SessionId;
            var mySid = GetProcessSid(me.Id);
            foreach (var other in Process.GetProcessesByName(me.ProcessName))
            {
                if (other.Id == me.Id)
                {
                    other.Dispose();
                    continue;
                }

                var health = ProbeHealth(other);
                var killable = SingleInstancePolicy.IsKillable(mySession, SafeSession(other), mySid, GetProcessSid(other.Id));
                result.Add(new OtherInstance(other.Id, health, killable));
                processes.Add(other);
            }
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("SingleInstanceProbe.Probe", ex);
        }

        return result;
    }

    private static int SafeSession(Process process)
    {
        try
        {
            return process.SessionId;
        }
        catch (Exception)
        {
            return -1;
        }
    }

    private static InstanceHealth ProbeHealth(Process process)
    {
        var windowsChecked = 0;
        var hung = false;
        try
        {
            foreach (ProcessThread thread in process.Threads)
            {
                EnumThreadWindows((uint)thread.Id, (hwnd, _) =>
                {
                    windowsChecked++;
                    var answered = SendMessageTimeoutW(
                        hwnd, WmNull, IntPtr.Zero, IntPtr.Zero, SmtoAbortIfHung | SmtoBlock, ProbeTimeoutMs, out _);
                    if (answered == IntPtr.Zero)
                    {
                        hung = true;
                        return false; // stop at the first window that does not answer
                    }

                    return true;
                }, IntPtr.Zero);

                if (hung)
                {
                    return InstanceHealth.Hung;
                }
            }
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("SingleInstanceProbe.ProbeHealth", ex);
            return InstanceHealth.Unknown;
        }

        return windowsChecked > 0 ? InstanceHealth.Responsive : InstanceHealth.Unknown;
    }

    private static string? GetProcessSid(int processId)
    {
        IntPtr processHandle = IntPtr.Zero;
        IntPtr tokenHandle = IntPtr.Zero;
        try
        {
            processHandle = OpenProcess(ProcessQueryLimitedInformation, false, processId);
            if (processHandle == IntPtr.Zero)
            {
                return null;
            }

            if (!OpenProcessToken(processHandle, TokenQuery, out tokenHandle))
            {
                return null;
            }

            using var identity = new WindowsIdentity(tokenHandle);
            return identity.User?.Value;
        }
        catch (Exception)
        {
            return null;
        }
        finally
        {
            if (tokenHandle != IntPtr.Zero)
            {
                CloseHandle(tokenHandle);
            }

            if (processHandle != IntPtr.Zero)
            {
                CloseHandle(processHandle);
            }
        }
    }
}
