using System.IO;
using VaccineAssist.Desktop.BarcodeCheck;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

public class BarcodeCheckViewModelTests
{
    private sealed class FakeSounds : IBarcodeSoundPlayer
    {
        public List<string> Played { get; } = new();
        public void PlayFound() => Played.Add("found");
        public void PlayNotFound() => Played.Add("notfound");
    }

    private static string WriteTempCsv(string content)
    {
        var path = Path.Combine(Path.GetTempPath(), $"barcode-vm-{Guid.NewGuid():N}.csv");
        File.WriteAllText(path, content);
        return path;
    }

    private static async Task<(BarcodeCheckViewModel Vm, FakeSounds Sounds)> LoadedAsync(string csv)
    {
        var sounds = new FakeSounds();
        var vm = new BarcodeCheckViewModel(sounds);
        var path = WriteTempCsv(csv);
        try
        {
            await vm.LoadFileAsync(path);
        }
        finally
        {
            File.Delete(path);
        }

        return (vm, sounds);
    }

    [Fact]
    public async Task LoadShowsFileNameAndCount()
    {
        var (vm, _) = await LoadedAsync("Barcode\n1000000001\n1000000002\n");

        Assert.True(vm.HasList);
        Assert.StartsWith("barcode-vm-", vm.FileName);
        Assert.EndsWith(".csv", vm.FileName);
        Assert.DoesNotContain(Path.DirectorySeparatorChar, vm.FileName);
        Assert.Equal("2 numbers loaded", vm.LoadedSummary);
        Assert.False(vm.HasMessage);
    }

    [Fact]
    public async Task FoundScanPlaysHappySoundAndShowsFound()
    {
        var (vm, sounds) = await LoadedAsync("1000000001\n");

        Assert.Equal(BarcodeScanOutcome.Found, vm.Scan("1000000001"));
        Assert.Equal("FOUND", vm.ResultTitle);
        Assert.Equal("1000000001", vm.LastScanned);
        Assert.Equal(new[] { "found" }, sounds.Played);
    }

    [Fact]
    public async Task UnknownScanPlaysErrorSoundAndShowsNotFound()
    {
        var (vm, sounds) = await LoadedAsync("1000000001\n");

        Assert.Equal(BarcodeScanOutcome.NotFound, vm.Scan("1000000009"));
        Assert.Equal("NOT FOUND", vm.ResultTitle);
        Assert.Equal("1000000009", vm.LastScanned);
        Assert.Equal(new[] { "notfound" }, sounds.Played);
    }

    [Fact]
    public async Task EmptyScanDoesNothing()
    {
        var (vm, sounds) = await LoadedAsync("1000000001\n");
        vm.Scan("1000000001");
        sounds.Played.Clear();

        Assert.Equal(BarcodeScanOutcome.None, vm.Scan("   "));
        Assert.Empty(sounds.Played);
        Assert.Equal("FOUND", vm.ResultTitle); // previous result untouched
    }

    [Fact]
    public async Task RapidScansAreEachHandledInOrder()
    {
        var (vm, sounds) = await LoadedAsync("1\n2\n3\n");

        var outcomes = new[] { "1", "9", "2", "8", "3", "7", "1", "1", "9", "2" }.Select(vm.Scan).ToArray();

        Assert.Equal(
            new[]
            {
                BarcodeScanOutcome.Found, BarcodeScanOutcome.NotFound, BarcodeScanOutcome.Found, BarcodeScanOutcome.NotFound,
                BarcodeScanOutcome.Found, BarcodeScanOutcome.NotFound, BarcodeScanOutcome.Found, BarcodeScanOutcome.Found,
                BarcodeScanOutcome.NotFound, BarcodeScanOutcome.Found,
            },
            outcomes);
        Assert.Equal(10, sounds.Played.Count);
        Assert.Equal("2", vm.LastScanned);
    }

    [Fact]
    public void ScanWithNoListLoadedDoesNothing()
    {
        var sounds = new FakeSounds();
        var vm = new BarcodeCheckViewModel(sounds);

        Assert.Equal(BarcodeScanOutcome.None, vm.Scan("123"));
        Assert.Empty(sounds.Played);
    }

    [Fact]
    public async Task ClearWipesListFileNameMessageAndResult()
    {
        var (vm, sounds) = await LoadedAsync("1000000001\n");
        vm.Scan("1000000001");

        vm.Clear();

        Assert.False(vm.HasList);
        Assert.Equal("", vm.FileName);
        Assert.Equal("", vm.LoadedSummary);
        Assert.Equal("", vm.Message);
        Assert.Equal("", vm.ResultTitle);
        Assert.Equal("", vm.LastScanned);
        Assert.Equal(BarcodeScanOutcome.None, vm.LastOutcome);

        sounds.Played.Clear();
        Assert.Equal(BarcodeScanOutcome.None, vm.Scan("1000000001")); // the list is really gone
        Assert.Empty(sounds.Played);
    }

    [Fact]
    public async Task ClearDuringALoadDiscardsTheLateResult()
    {
        var sounds = new FakeSounds();
        var vm = new BarcodeCheckViewModel(sounds);
        var path = WriteTempCsv("1000000001\n");
        try
        {
            var load = vm.LoadFileAsync(path);
            vm.Clear(); // window closed while the file was still being read
            await load;
        }
        finally
        {
            File.Delete(path);
        }

        Assert.False(vm.HasList);
        Assert.Equal("", vm.FileName);
    }

    [Fact]
    public async Task MissingFileGivesAPlainMessageAndStaysBlank()
    {
        var vm = new BarcodeCheckViewModel(new FakeSounds());

        await vm.LoadFileAsync(Path.Combine(Path.GetTempPath(), $"nope-{Guid.NewGuid():N}.csv"));

        Assert.False(vm.HasList);
        Assert.True(vm.HasMessage);
        Assert.Equal("", vm.FileName);
    }

    [Fact]
    public async Task EmptyFileGivesAMessage()
    {
        var (vm, _) = await LoadedAsync("Barcode\n\n");

        Assert.False(vm.HasList);
        Assert.Contains("No numbers", vm.Message);
    }

    [Fact]
    public async Task ABadFileAfterAGoodOneLeavesTheWindowBlank()
    {
        var (vm, _) = await LoadedAsync("1000000001\n");
        var bad = Path.Combine(Path.GetTempPath(), $"nope-{Guid.NewGuid():N}.xlsx");

        await vm.LoadFileAsync(bad);

        Assert.False(vm.HasList);
        Assert.True(vm.HasMessage);
    }

    [Fact]
    public async Task ScientificNotationCellsProduceAWarningButStillLoadTheRest()
    {
        var (vm, _) = await LoadedAsync("1.23457E+11\n1000000001\n");

        Assert.True(vm.HasList);
        Assert.Contains("scientific notation", vm.Message);
    }

    [Fact]
    public async Task OverlongScanIsTruncatedForDisplayOnly()
    {
        var (vm, _) = await LoadedAsync("1\n");

        vm.Scan(new string('9', 200));

        Assert.True(vm.LastScanned.Length < 60);
        Assert.Equal("NOT FOUND", vm.ResultTitle);
    }
}
