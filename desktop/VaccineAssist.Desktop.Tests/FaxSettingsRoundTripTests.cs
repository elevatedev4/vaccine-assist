using System.Text.Json;
using VaccineAssist.Desktop.Settings;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// V-T65 (2026-09-29): a workstation that already has a settings.json from
/// before this brief (input folder, daily-run time/enabled, and the
/// prescriber-fax table were all real fields then) must still load
/// cleanly — System.Text.Json's default JsonSerializer.Deserialize
/// silently ignores unknown JSON members, so removing those C# properties
/// (see FaxSettings.cs) doesn't need any explicit migration code. Exercises
/// JsonSerializer directly against AppSettings/FaxSettings rather than
/// through LocalSettingsService, which hardcodes its file path to
/// %AppData% (not injectable) — the behavior under test is the
/// deserialization itself, not the file I/O around it.
/// </summary>
public class FaxSettingsRoundTripTests
{
    [Fact]
    public void OldSettingsJsonWithRemovedFieldsStillLoads()
    {
        // "Provider": 1 is FaxProvider.Notifyre — LocalSettingsService's
        // JsonSerializerOptions has no JsonStringEnumConverter, so a real
        // settings.json on disk stores the enum's underlying int, not its
        // name.
        const string oldJson = """
        {
          "CloudApiBaseUrl": "https://vaccine-assist.vercel.app",
          "SupabaseUrl": "https://xxxxxxxxxxxx.supabase.co",
          "SupabaseAnonKey": "synthetic-anon-key",
          "LastSignedInEmail": "pharmacist@example.com",
          "PriorityValue": "Vaccine",
          "ShowPioneerOverlay": true,
          "Fax": {
            "Provider": 1,
            "InputFolder": "C:\\Old\\Input\\Folder",
            "DailyRunTime": "18:30",
            "DailyRunEnabled": true,
            "PharmacyName": "Test Pharmacy",
            "PharmacyPhone": "5555550100",
            "PharmacyFax": "5555550101",
            "SenderEmail": "sender@example.com",
            "SignatureName": "Test Pharmacist, Pharm.D.",
            "ColumnMap": {
              "PatientFullNameHeader": "Patient Full Name Last then First",
              "VaccineNameHeader": "Dispensed Item Name",
              "AdministeredDateHeader": "Immunization Administered On",
              "DobHeader": "Patient Date of Birth"
            }
          }
        }
        """;

        var settings = JsonSerializer.Deserialize<AppSettings>(oldJson);

        Assert.NotNull(settings);
        // Every field that still exists round-trips correctly...
        Assert.Equal("https://vaccine-assist.vercel.app", settings!.CloudApiBaseUrl);
        Assert.Equal(VaccineAssist.Desktop.Fax.FaxProvider.Notifyre, settings.Fax.Provider);
        Assert.Equal("Test Pharmacy", settings.Fax.PharmacyName);
        Assert.Equal("5555550101", settings.Fax.PharmacyFax);
        Assert.Equal("Test Pharmacist, Pharm.D.", settings.Fax.SignatureName);
        Assert.Equal("Dispensed Item Name", settings.Fax.ColumnMap.VaccineNameHeader);

        // ...and the removed fields (InputFolder/DailyRunTime/DailyRunEnabled)
        // are just silently dropped — no exception, no leftover data
        // anywhere to reflect them (FaxSettings no longer declares those
        // properties at all).
    }

    [Fact]
    public void FreshDefaultsSerializeAndDeserializeRoundTrip()
    {
        var original = new AppSettings();

        var json = JsonSerializer.Serialize(original);
        var roundTripped = JsonSerializer.Deserialize<AppSettings>(json);

        Assert.NotNull(roundTripped);
        Assert.Equal(original.Fax.Provider, roundTripped!.Fax.Provider);
        Assert.Equal(original.Fax.SignatureName, roundTripped.Fax.SignatureName);
    }
}
