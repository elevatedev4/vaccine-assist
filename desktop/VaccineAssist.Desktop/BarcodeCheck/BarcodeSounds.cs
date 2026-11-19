using System.IO;

namespace VaccineAssist.Desktop.BarcodeCheck;

/// <summary>Plays the two feedback sounds. Behind an interface so the view
/// model is testable without audio hardware.</summary>
public interface IBarcodeSoundPlayer
{
    /// <summary>Short, happy chirp. Must return immediately.</summary>
    void PlayFound();

    /// <summary>Short, low error buzz. Must return immediately.</summary>
    void PlayNotFound();
}

/// <summary>Builds the two feedback sounds as tiny in-memory WAV files (no
/// bundled binary assets to ship or lose).</summary>
public static class BarcodeToneWav
{
    private const int SampleRate = 22050;

    /// <summary>Two quick rising notes, about 0.17 s.</summary>
    public static byte[] BuildHappy() =>
        Build(new[] { (880.0, 0.06, false), (1320.0, 0.11, false) }, amplitude: 0.5);

    /// <summary>One low square-wave buzz, about 0.28 s.</summary>
    public static byte[] BuildError() =>
        Build(new[] { (160.0, 0.28, true) }, amplitude: 0.45);

    internal static byte[] Build(IReadOnlyList<(double Frequency, double Seconds, bool Square)> notes, double amplitude)
    {
        var samples = new List<short>();
        foreach (var (frequency, seconds, square) in notes)
        {
            var count = (int)(SampleRate * seconds);
            // 5 ms fade in/out so a note never clicks.
            var fade = Math.Max(1, (int)(SampleRate * 0.005));
            for (var i = 0; i < count; i++)
            {
                var phase = 2 * Math.PI * frequency * i / SampleRate;
                var wave = square ? Math.Sign(Math.Sin(phase)) * 0.6 : Math.Sin(phase);
                var envelope = Math.Min(1.0, Math.Min(i, count - 1 - i) / (double)fade);
                samples.Add((short)(wave * envelope * amplitude * short.MaxValue));
            }
        }

        using var stream = new MemoryStream();
        using var writer = new BinaryWriter(stream);
        var dataBytes = samples.Count * 2;
        writer.Write("RIFF".ToCharArray());
        writer.Write(36 + dataBytes);
        writer.Write("WAVE".ToCharArray());
        writer.Write("fmt ".ToCharArray());
        writer.Write(16);                 // fmt chunk size
        writer.Write((short)1);           // PCM
        writer.Write((short)1);           // mono
        writer.Write(SampleRate);
        writer.Write(SampleRate * 2);     // byte rate
        writer.Write((short)2);           // block align
        writer.Write((short)16);          // bits per sample
        writer.Write("data".ToCharArray());
        writer.Write(dataBytes);
        foreach (var sample in samples)
        {
            writer.Write(sample);
        }

        writer.Flush();
        return stream.ToArray();
    }
}
