using System;
using System.Threading.Tasks;
using VaccineAssist.Desktop.Services;
using VaccineAssist.Desktop.Settings;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// Hand-rolled fakes (no mocking framework — matches this repo's
/// dependency-light style) for the interfaces LoginViewModel depends on.
/// </summary>
internal sealed class FakeAuthService : IAuthService
{
    private readonly AuthResult _result;

    public FakeAuthService(AuthResult result)
    {
        _result = result;
    }

    public bool IsSignedIn { get; private set; }
    public string? AccessToken { get; private set; }
    public int SignInCallCount { get; private set; }
    public string? LastEmail { get; private set; }
    public string? LastPassword { get; private set; }

    public Task<AuthResult> SignInAsync(string email, string password)
    {
        SignInCallCount++;
        LastEmail = email;
        LastPassword = password;
        if (_result.Success)
        {
            IsSignedIn = true;
            AccessToken = "fake-token";
        }
        return Task.FromResult(_result);
    }

    public Task SignOutAsync()
    {
        IsSignedIn = false;
        AccessToken = null;
        return Task.CompletedTask;
    }
}

internal sealed class FakeLocalSettingsService : ILocalSettingsService
{
    private readonly AppSettings _settings;

    /// <summary>When set, Save() throws this instead of succeeding —
    /// regression coverage for the crash fix in LoginViewModel.SignInAsync
    /// (Will, 2026-08-19/20): a locked/unwritable settings.json on a real
    /// workstation must not stop sign-in from completing.</summary>
    public Exception? ThrowOnSave { get; set; }

    public FakeLocalSettingsService(AppSettings settings)
    {
        _settings = settings;
    }

    public int SaveCallCount { get; private set; }

    public AppSettings Load() => _settings;

    public void Save(AppSettings settings)
    {
        SaveCallCount++;
        if (ThrowOnSave is not null)
        {
            throw ThrowOnSave;
        }
    }
}

internal sealed class FakeAutoLoginConfigService : IAutoLoginConfigService
{
    private readonly AutoLoginConfig? _config;

    public FakeAutoLoginConfigService(AutoLoginConfig? config)
    {
        _config = config;
    }

    public AutoLoginConfig? Load() => _config;
}
