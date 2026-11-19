using System.IO;
using System.Media;
using VaccineAssist.Desktop.Logging;

namespace VaccineAssist.Desktop.BarcodeCheck;

/// <summary>
/// SoundPlayer-backed player. SoundPlayer.Play() starts playback on its own
/// thread and returns at once, and starting a new sound stops the one still
/// playing, so rapid scans never queue sounds up behind each other. Any
/// audio failure (no sound device, etc.) is swallowed: scanning must keep
/// working without sound.
/// </summary>
public sealed class BarcodeSoundPlayer : IBarcodeSoundPlayer, IDisposable
{
    private readonly SoundPlayer? _happy;
    private readonly SoundPlayer? _error;

    public BarcodeSoundPlayer()
    {
        _happy = TryCreate(BarcodeToneWav.BuildHappy());
        _error = TryCreate(BarcodeToneWav.BuildError());
    }

    public void PlayFound() => TryPlay(_happy);

    public void PlayNotFound() => TryPlay(_error);

    public void Dispose()
    {
        try
        {
            _happy?.Stop();
            _error?.Stop();
        }
        catch
        {
            // Closing the window must never fail over audio.
        }

        _happy?.Dispose();
        _error?.Dispose();
    }

    private static SoundPlayer? TryCreate(byte[] wav)
    {
        try
        {
            var player = new SoundPlayer(new MemoryStream(wav));
            player.Load();
            return player;
        }
        catch (Exception ex)
        {
            AppFileLog.Log($"[BarcodeCheck] sound unavailable: {ex.GetType().Name}");
            return null;
        }
    }

    private static void TryPlay(SoundPlayer? player)
    {
        try
        {
            player?.Play();
        }
        catch
        {
            // No sound device / driver hiccup: ignore, the on-screen
            // result still shows.
        }
    }
}
