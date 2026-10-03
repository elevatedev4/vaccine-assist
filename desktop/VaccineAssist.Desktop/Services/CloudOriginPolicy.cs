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

    /// <summary>
    /// Navigations the embedded WebView2 may perform: the cloud origin
    /// itself, about: pages, WebView2's own failed-load page
    /// (chrome-error:), and blob: URLs minted by the cloud page (CSV
    /// exports via URL.createObjectURL + a download link — the blob URL
    /// embeds the page's origin, which must be the cloud's). Everything
    /// else is cancelled by CloudPageView and, for http(s), opened in the
    /// default browser. A redirect to a different host (CloudApiBaseUrl
    /// not being the canonical host) therefore counts as external.
    /// </summary>
    public static bool IsAllowedNavigation(string? url, string? cloudBaseUrl)
    {
        if (string.IsNullOrWhiteSpace(url))
        {
            return false;
        }

        if (IsCloudOrigin(url, cloudBaseUrl) ||
            url.StartsWith("about:", StringComparison.OrdinalIgnoreCase) ||
            url.StartsWith("chrome-error:", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        const string blobPrefix = "blob:";
        return url.StartsWith(blobPrefix, StringComparison.OrdinalIgnoreCase) &&
               IsCloudOrigin(url[blobPrefix.Length..], cloudBaseUrl);
    }
}
