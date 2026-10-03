using System;

namespace VaccineAssist.Desktop.Services;

/// <summary>
/// "Is this URL on the cloud app's own origin?" — the gate for anything
/// that hands the embedded WebView2 a credential (the access-token push)
/// and for keeping that WebView2 on the cloud app. Scheme + host + port
/// must match the configured CloudApiBaseUrl exactly; relative, malformed
/// or about:/data: URLs never match.
/// </summary>
public static class CloudOriginPolicy
{
    public static bool IsCloudOrigin(string? url, string? cloudBaseUrl)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var candidate) ||
            !Uri.TryCreate(cloudBaseUrl, UriKind.Absolute, out var cloud))
        {
            return false;
        }

        return string.Equals(candidate.Scheme, cloud.Scheme, StringComparison.OrdinalIgnoreCase) &&
               string.Equals(candidate.Host, cloud.Host, StringComparison.OrdinalIgnoreCase) &&
               candidate.Port == cloud.Port;
    }
}
