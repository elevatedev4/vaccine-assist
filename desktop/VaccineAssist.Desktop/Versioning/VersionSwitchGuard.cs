using System.Threading;

namespace VaccineAssist.Desktop.Versioning;

/// <summary>
/// Lets only one version switch run at a time: the confirm box pumps
/// messages, so a second click (tray + overlay) could otherwise stack a
/// second confirm box. TryEnter returns false while one is in progress.
/// </summary>
public sealed class VersionSwitchGuard
{
    private int _active;

    public bool IsActive => Volatile.Read(ref _active) != 0;

    public bool TryEnter() => Interlocked.CompareExchange(ref _active, 1, 0) == 0;

    public void Exit() => Volatile.Write(ref _active, 0);
}
