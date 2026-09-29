using VaccineAssist.Desktop.Fax;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// Reviewer fix (2026-09-28, blocking): FaxSettingsViewModel's Save/Test-
/// connection/Forget-key persistence decisions are factored into
/// NotifyreKeyPersistencePolicy (pure, static) specifically so they're
/// directly unit-testable — FaxSettingsViewModel itself can't be
/// instantiated/run here (AsyncRelayCommand/ICommand need the
/// WindowsBase/WindowsDesktop runtime, which can't execute on macOS; see
/// FaxKeyStatus's own doc comment for the same reasoning). Synthetic
/// values only.
/// </summary>
public class NotifyreKeyPersistencePolicyTests
{
    // ---- DecideSave (blank-save-keeps-key) ----

    [Fact]
    public void BlankBoxWithAnExistingStoredTokenKeepsTheStoredTokenUnchanged()
    {
        var decision = NotifyreKeyPersistencePolicy.DecideSave(normalizedTypedToken: "", storedToken: "test-token-old");

        Assert.True(decision.CanSave);
        Assert.Null(decision.ErrorMessage);
        Assert.Equal("test-token-old", decision.TokenToPersist);
        Assert.False(decision.TokenChanged);
    }

    [Fact]
    public void ANonBlankBoxAlwaysReplacesWhateverWasStored()
    {
        var decision = NotifyreKeyPersistencePolicy.DecideSave(normalizedTypedToken: "test-token-new", storedToken: "test-token-old");

        Assert.True(decision.CanSave);
        Assert.Equal("test-token-new", decision.TokenToPersist);
        Assert.True(decision.TokenChanged);
    }

    [Fact]
    public void ANonBlankBoxWithNothingPreviouslyStoredSavesTheTypedToken()
    {
        var decision = NotifyreKeyPersistencePolicy.DecideSave(normalizedTypedToken: "test-token-new", storedToken: "");

        Assert.True(decision.CanSave);
        Assert.Equal("test-token-new", decision.TokenToPersist);
        Assert.True(decision.TokenChanged);
    }

    [Fact]
    public void ABlankBoxWithNothingEverStoredCannotSave()
    {
        var decision = NotifyreKeyPersistencePolicy.DecideSave(normalizedTypedToken: "", storedToken: "");

        Assert.False(decision.CanSave);
        Assert.Equal("Enter a Notifyre API token.", decision.ErrorMessage);
    }

    // ---- DecideTest ----

    [Fact]
    public void TestingWithATypedBoxValueUsesTheBoxNotTheStoredKey()
    {
        var decision = NotifyreKeyPersistencePolicy.DecideTest(normalizedTypedToken: "test-token-box", storedToken: "test-token-stored");

        Assert.True(decision.CanTest);
        Assert.Equal("test-token-box", decision.TokenToTest);
        Assert.False(decision.UsingStoredKey);
    }

    [Fact]
    public void TestingWithABlankBoxFallsBackToTheStoredKey()
    {
        var decision = NotifyreKeyPersistencePolicy.DecideTest(normalizedTypedToken: "", storedToken: "test-token-stored");

        Assert.True(decision.CanTest);
        Assert.Equal("test-token-stored", decision.TokenToTest);
        Assert.True(decision.UsingStoredKey);
    }

    [Fact]
    public void TestingWithNothingTypedAndNothingStoredCannotTest()
    {
        var decision = NotifyreKeyPersistencePolicy.DecideTest(normalizedTypedToken: "", storedToken: "");

        Assert.False(decision.CanTest);
        Assert.Equal("Enter a Notifyre API token to test.", decision.ErrorMessage);
    }

    // ---- ShouldPersistDiscoveredAuthMode (the actual blocking bug) ----

    [Fact]
    public void ADiscoveredAuthModeIsSafeToPersistWhenTestingTheStoredKey()
    {
        Assert.True(NotifyreKeyPersistencePolicy.ShouldPersistDiscoveredAuthMode(usingStoredKey: true));
    }

    [Fact]
    public void ADiscoveredAuthModeIsNeverPersistedWhenTestingAnUnsavedBoxValue()
    {
        // This is the reviewer's blocking finding: Test connection with a
        // BOX (unsaved) value must never write to the credential store,
        // even when Notifyre's probe succeeds under a non-default auth
        // mode — only the next real Save may persist anything.
        Assert.False(NotifyreKeyPersistencePolicy.ShouldPersistDiscoveredAuthMode(usingStoredKey: false));
    }

    // ---- ApplyForget ----

    [Fact]
    public void ForgetClearsOnlyTheNotifyreTokenAndItsSavedAtTimestamp()
    {
        var current = new FaxCredentials
        {
            AccessId = "test-access-id",
            AccessPassword = "test-password",
            ApiToken = "test-token",
            NotifyreAuthMode = NotifyreAuthMode.Bearer,
            NotifyreTokenSavedAtUtc = System.DateTime.UtcNow,
        };

        var result = NotifyreKeyPersistencePolicy.ApplyForget(current);

        Assert.Equal("", result.ApiToken);
        Assert.Null(result.NotifyreTokenSavedAtUtc);
        // SRFax fields and auth mode are untouched by Forget.
        Assert.Equal("test-access-id", result.AccessId);
        Assert.Equal("test-password", result.AccessPassword);
        Assert.Equal(NotifyreAuthMode.Bearer, result.NotifyreAuthMode);
    }

    [Fact]
    public void AfterForgetTheKeyStatusTextReadsNoKeySaved()
    {
        // End-to-end of the two pure pieces together: Forget's output
        // feeds FaxKeyStatus.Describe the same way FaxSettingsViewModel
        // does (via FaxKeyStatus.Last4OfToken(forgotten.ApiToken)).
        var forgotten = NotifyreKeyPersistencePolicy.ApplyForget(new FaxCredentials { ApiToken = "test-token" });

        var statusText = FaxKeyStatus.Describe(FaxKeyStatus.Last4OfToken(forgotten.ApiToken), forgotten.NotifyreTokenSavedAtUtc);

        Assert.Equal("No key saved", statusText);
    }
}
