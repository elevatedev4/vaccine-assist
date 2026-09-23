using System.Net.Http;

namespace VaccineAssist.Desktop.Fax;

/// <summary>The one place that maps FaxProvider -> a concrete IFaxClient.
/// Adding another vendor is a new IFaxClient implementation plus one case
/// here — nothing else in the app (FaxRunOrchestrator,
/// FaxSettingsViewModel, App.xaml.cs) ever names SrFaxClient or
/// NotifyreFaxClient directly.</summary>
public static class FaxClientFactory
{
    public static IFaxClient Create(FaxProvider provider, HttpClient httpClient, FaxCredentials credentials) => provider switch
    {
        FaxProvider.SrFax => new SrFaxClient(httpClient, credentials),
        FaxProvider.Notifyre => new NotifyreFaxClient(httpClient, credentials),
        _ => throw new NotSupportedException($"Unsupported fax provider: {provider}"),
    };
}
