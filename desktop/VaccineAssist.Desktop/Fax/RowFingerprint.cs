using System.Security.Cryptography;
using System.Text;

namespace VaccineAssist.Desktop.Fax;

/// <summary>
/// Pure hashing logic split out of ImmunizationRecord.Fingerprint so it's
/// directly unit-testable (same-input-same-output, different-input-
/// different-output) without constructing a full ImmunizationRecord.
/// </summary>
public static class RowFingerprint
{
    /// <summary>SHA-256 hex digest of patient name + DOB + vaccine + lot +
    /// administered date, lowercased/trimmed first so whitespace/casing
    /// differences between two exports of the same administration don't
    /// produce two different fingerprints (and therefore two faxes).</summary>
    public static string Compute(ImmunizationRecord record) => Compute(
        record.PatientFirstName, record.PatientLastName, record.PatientDob,
        record.VaccineName, record.Lot, record.AdministeredDate);

    public static string Compute(
        string patientFirstName,
        string patientLastName,
        DateOnly? patientDob,
        string vaccineName,
        string? lot,
        DateOnly administeredDate)
    {
        var raw = string.Join('|',
            Normalize(patientFirstName),
            Normalize(patientLastName),
            patientDob?.ToString("yyyy-MM-dd") ?? "",
            Normalize(vaccineName),
            Normalize(lot),
            administeredDate.ToString("yyyy-MM-dd"));

        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(raw));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }

    private static string Normalize(string? value) => (value ?? "").Trim().ToLowerInvariant();
}
