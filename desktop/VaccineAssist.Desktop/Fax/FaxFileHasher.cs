using System.Security.Cryptography;

namespace VaccineAssist.Desktop.Fax;

/// <summary>
/// Pure SHA-256 hashing of an uploaded report file's raw bytes — V-T65 R5
/// (Will, verbatim, 2026-09-29): "make sure that things don't get re-sent
/// if somebody reuploads the same file." Split out so it's directly
/// unit-testable (same-bytes-same-hash, different-bytes-different-hash)
/// without touching disk, same convention as RowFingerprint.
/// </summary>
public static class FaxFileHasher
{
    public static string ComputeHex(byte[] fileBytes)
    {
        var hash = SHA256.HashData(fileBytes);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }
}
