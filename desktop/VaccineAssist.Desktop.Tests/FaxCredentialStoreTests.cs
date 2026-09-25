using System;
using System.IO;
using VaccineAssist.Desktop.Fax;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// Unit tests for FaxCredentialStore — same style/DPAPI caveat as
/// SessionStoreTests.cs (DPAPI is Windows-only, so these are only
/// meaningful run on Windows, which is where this whole suite runs).
/// "test-token"/"test-password" below are synthetic fixtures, never real
/// credentials.
/// </summary>
public class FaxCredentialStoreTests
{
    [Fact]
    public void LoadReturnsNullWhenFileDoesNotExist()
    {
        var path = Path.Combine(Path.GetTempPath(), Guid.NewGuid() + ".json");
        var store = new FaxCredentialStore(path);

        Assert.Null(store.Load());
    }

    [Fact]
    public void SaveThenLoadRoundTripsAllThreeFieldsExactly()
    {
        var path = Path.Combine(Path.GetTempPath(), Guid.NewGuid() + ".json");
        try
        {
            var store = new FaxCredentialStore(path);
            var original = new FaxCredentials { AccessId = "test-access-id", AccessPassword = "test-password", ApiToken = "test-token" };

            store.Save(original);
            var loaded = store.Load();

            Assert.NotNull(loaded);
            Assert.Equal("test-access-id", loaded!.AccessId);
            Assert.Equal("test-password", loaded.AccessPassword);
            Assert.Equal("test-token", loaded.ApiToken);
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void ANotifyreOnlyInstallRoundTripsTheTokenWithBlankSrFaxFields()
    {
        // Fresh install, Notifyre only entered — AccessId/AccessPassword
        // were never typed in, matching FaxSettings.Provider's new
        // Notifyre-by-default. Must NOT come back null just because the
        // SRFax half is blank.
        var path = Path.Combine(Path.GetTempPath(), Guid.NewGuid() + ".json");
        try
        {
            var store = new FaxCredentialStore(path);
            store.Save(new FaxCredentials { ApiToken = "test-token" });

            var loaded = store.Load();

            Assert.NotNull(loaded);
            Assert.Equal("test-token", loaded!.ApiToken);
            Assert.Equal("", loaded.AccessId);
            Assert.Equal("", loaded.AccessPassword);
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void ASrFaxOnlyInstallRoundTripsWithABlankToken()
    {
        // An install that's only ever used SRFax (pre-Notifyre, or never
        // switched) — ApiToken was never typed in.
        var path = Path.Combine(Path.GetTempPath(), Guid.NewGuid() + ".json");
        try
        {
            var store = new FaxCredentialStore(path);
            store.Save(new FaxCredentials { AccessId = "test-access-id", AccessPassword = "test-password" });

            var loaded = store.Load();

            Assert.NotNull(loaded);
            Assert.Equal("test-access-id", loaded!.AccessId);
            Assert.Equal("", loaded.ApiToken);
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void TheTokenIsNotStoredInPlainTextOnDisk()
    {
        var path = Path.Combine(Path.GetTempPath(), Guid.NewGuid() + ".json");
        try
        {
            var store = new FaxCredentialStore(path);
            store.Save(new FaxCredentials { ApiToken = "super-secret-notifyre-token" });

            var rawJson = File.ReadAllText(path);

            Assert.DoesNotContain("super-secret-notifyre-token", rawJson);
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void LoadReturnsNullOnCorruptJsonRatherThanThrowing()
    {
        var path = Path.Combine(Path.GetTempPath(), Guid.NewGuid() + ".json");
        try
        {
            File.WriteAllText(path, "{ this is not valid json");
            var store = new FaxCredentialStore(path);

            Assert.Null(store.Load());
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void SaveThenLoadRoundTripsANonDocumentedNotifyreAuthMode()
    {
        // V-T53 401 follow-up (2026-09-25): once NotifyreFaxClient's probe
        // discovers a non-documented header form works, that choice must
        // survive a save/load round trip so a later app run keeps using it.
        var path = Path.Combine(Path.GetTempPath(), Guid.NewGuid() + ".json");
        try
        {
            var store = new FaxCredentialStore(path);
            store.Save(new FaxCredentials { ApiToken = "test-token", NotifyreAuthMode = NotifyreAuthMode.Bearer });

            var loaded = store.Load();

            Assert.NotNull(loaded);
            Assert.Equal(NotifyreAuthMode.Bearer, loaded!.NotifyreAuthMode);
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void LoadDefaultsNotifyreAuthModeToXApiTokenWhenTheFieldIsAbsent()
    {
        // An older credentials.json written before NotifyreAuthMode
        // existed — must fall back to the documented default rather than
        // failing the whole load or throwing on Enum.Parse.
        var path = Path.Combine(Path.GetTempPath(), Guid.NewGuid() + ".json");
        try
        {
            var store = new FaxCredentialStore(path);
            store.Save(new FaxCredentials { ApiToken = "test-token" });

            // Simulate an older credentials.json written before
            // NotifyreAuthMode existed by removing the property entirely
            // (via JsonNode, not string surgery) so the rest of the file
            // stays valid JSON.
            var node = System.Text.Json.Nodes.JsonNode.Parse(File.ReadAllText(path))!.AsObject();
            node.Remove("NotifyreAuthMode");
            File.WriteAllText(path, node.ToJsonString());

            var loaded = store.Load();

            Assert.NotNull(loaded);
            Assert.Equal(NotifyreAuthMode.XApiToken, loaded!.NotifyreAuthMode);
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void DeleteRemovesAPreviouslySavedCredentialsFile()
    {
        var path = Path.Combine(Path.GetTempPath(), Guid.NewGuid() + ".json");
        try
        {
            var store = new FaxCredentialStore(path);
            store.Save(new FaxCredentials { ApiToken = "test-token" });
            Assert.NotNull(store.Load());

            store.Delete();

            Assert.Null(store.Load());
            Assert.False(File.Exists(path));
        }
        finally
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
    }
}
