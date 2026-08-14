using System;
using System.IO;
using VaccineAssist.Desktop.Settings;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// Unit tests for AutoLoginConfigService.Load() — the config-file parsing
/// bootstrap-fresh.ps1's seeded %LocalAppData%\VaccineAssist\autologin.json
/// goes through at app startup. Uses the injectable-file-path constructor
/// against temp files instead of the real %LocalAppData% location — no
/// synthetic-vs-real data concern here since "pharmacy@example.test" /
/// "hunter2" below are placeholder test fixtures, never real credentials.
/// </summary>
public class AutoLoginConfigServiceTests
{
    [Fact]
    public void ReturnsNullWhenFileDoesNotExist()
    {
        var path = Path.Combine(Path.GetTempPath(), Guid.NewGuid() + ".json");
        var service = new AutoLoginConfigService(path);

        Assert.Null(service.Load());
    }

    [Fact]
    public void ParsesValidJsonFile()
    {
        var path = Path.Combine(Path.GetTempPath(), Guid.NewGuid() + ".json");
        try
        {
            File.WriteAllText(path, "{\"Email\":\"pharmacy@example.test\",\"Password\":\"hunter2\"}");
            var service = new AutoLoginConfigService(path);

            var config = service.Load();

            Assert.NotNull(config);
            Assert.Equal("pharmacy@example.test", config!.Email);
            Assert.Equal("hunter2", config.Password);
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void ReturnsNullOnCorruptJsonRatherThanThrowing()
    {
        var path = Path.Combine(Path.GetTempPath(), Guid.NewGuid() + ".json");
        try
        {
            File.WriteAllText(path, "{ this is not valid json");
            var service = new AutoLoginConfigService(path);

            var config = service.Load();

            Assert.Null(config);
        }
        finally
        {
            File.Delete(path);
        }
    }
}
