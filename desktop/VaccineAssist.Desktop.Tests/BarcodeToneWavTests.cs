using System.Text;
using VaccineAssist.Desktop.BarcodeCheck;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

public class BarcodeToneWavTests
{
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void BuildsAValidShortPcmWav(bool happy)
    {
        var wav = happy ? BarcodeToneWav.BuildHappy() : BarcodeToneWav.BuildError();

        Assert.Equal("RIFF", Encoding.ASCII.GetString(wav, 0, 4));
        Assert.Equal("WAVE", Encoding.ASCII.GetString(wav, 8, 4));
        Assert.Equal("data", Encoding.ASCII.GetString(wav, 36, 4));
        Assert.Equal(wav.Length - 8, BitConverter.ToInt32(wav, 4));
        Assert.Equal(wav.Length - 44, BitConverter.ToInt32(wav, 40));

        var sampleRate = BitConverter.ToInt32(wav, 24);
        var seconds = (wav.Length - 44) / 2.0 / sampleRate;
        Assert.InRange(seconds, 0.1, 0.5); // short
    }

    [Fact]
    public void TheTwoSoundsDiffer()
    {
        Assert.NotEqual(BarcodeToneWav.BuildHappy(), BarcodeToneWav.BuildError());
    }
}
