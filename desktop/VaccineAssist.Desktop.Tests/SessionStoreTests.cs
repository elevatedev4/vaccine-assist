using System;
using System.IO;
using VaccineAssist.Desktop.Settings;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// Unit tests for SessionStore — the DPAPI-backed 90-day persisted-session
/// file (Will, 2026-09-13). Same style as AutoLoginConfigServiceTests.cs:
/// the injectable-file-path constructor against temp files instead of the
/// real %LocalAppData% location. "access-token-fixture"/"refresh-token-
/// fixture" below are placeholder test fixtures, never real tokens.
///
/// DPAPI (System.Security.Cryptography.ProtectedData, CurrentUser scope)
/// only works on Windows, same constraint every other test in this
/// Windows-only WPF/FlaUI project already has — these tests are only
/// meaningful run on Windows, which is where this whole suite runs.
/// </summary>
public class SessionStoreTests
{
    [Fact]
    public void LoadReturnsNullWhenFileDoesNotExist()
    {
        var path = Path.Combine(Path.GetTempPath(), Guid.NewGuid() + ".json");
        var store = new SessionStore(path);

        Assert.Null(store.Load());
    }

    [Fact]
    public void SaveThenLoadRoundTripsTheSessionExactly()
    {
        var path = Path.Combine(Path.GetTempPath(), Guid.NewGuid() + ".json");
        try
        {
            var store = new SessionStore(path);
            var issuedAt = new DateTime(2026, 9, 13, 8, 30, 0, DateTimeKind.Utc);
            var original = new PersistedSession("access-token-fixture", "refresh-token-fixture", issuedAt);

            store.Save(original);
            var loaded = store.Load();

            Assert.NotNull(loaded);
            Assert.Equal("access-token-fixture", loaded!.AccessToken);
            Assert.Equal("refresh-token-fixture", loaded.RefreshToken);
            Assert.Equal(issuedAt, loaded.IssuedAtUtc);
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void TheTokensAreNotStoredInPlainTextOnDisk()
    {
        // DPAPI-encryption regression guard — the whole point of storing
        // these at all (Will's brief names DPAPI explicitly).
        var path = Path.Combine(Path.GetTempPath(), Guid.NewGuid() + ".json");
        try
        {
            var store = new SessionStore(path);
            store.Save(new PersistedSession("super-secret-access-token", "super-secret-refresh-token", DateTime.UtcNow));

            var rawJson = File.ReadAllText(path);

            Assert.DoesNotContain("super-secret-access-token", rawJson);
            Assert.DoesNotContain("super-secret-refresh-token", rawJson);
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
            var store = new SessionStore(path);

            Assert.Null(store.Load());
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void DeleteRemovesAPreviouslySavedSession()
    {
        var path = Path.Combine(Path.GetTempPath(), Guid.NewGuid() + ".json");
        try
        {
            var store = new SessionStore(path);
            store.Save(new PersistedSession("access", "refresh", DateTime.UtcNow));
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

    [Fact]
    public void DeleteOnAMissingFileDoesNotThrow()
    {
        var path = Path.Combine(Path.GetTempPath(), Guid.NewGuid() + ".json");
        var store = new SessionStore(path);

        var exception = Record.Exception(() => store.Delete());

        Assert.Null(exception);
    }
}
