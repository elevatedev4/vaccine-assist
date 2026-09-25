namespace VaccineAssist.Desktop.Fax;

/// <summary>
/// Which HTTP auth header form Notifyre actually accepted for this
/// account's API token — discovered empirically by
/// NotifyreFaxClient.TestConnectionAsync's probe sequence (V-T53 401
/// follow-up, 2026-09-25) rather than assumed from docs.notifyre.com's
/// authentication page, which documents ONLY XApiToken. Will's account
/// returned Notifyre's identical "Access denied" 401 body for the
/// documented form even with a token he confirmed was correct, which
/// meant either the token was never going to work no matter how it was
/// sent, or Notifyre's real auth check wants the token somewhere other
/// than the documented header — this enum names each form the probe
/// tries so the discovered answer can be stored alongside the token
/// (FaxCredentials.NotifyreAuthMode) and reused for every later request
/// on this <see cref="NotifyreFaxClient"/>, not just the one Test
/// connection call that found it.
/// </summary>
public enum NotifyreAuthMode
{
    /// <summary>docs.notifyre.com/api/authentication's documented form:
    /// header "x-api-token: &lt;token&gt;". Default for every account
    /// until a probe proves otherwise.</summary>
    XApiToken,

    /// <summary>header "Authorization: Bearer &lt;token&gt;".</summary>
    Bearer,

    /// <summary>header "Authorization: &lt;token&gt;" with no scheme
    /// prefix.</summary>
    RawAuthorization,
}
