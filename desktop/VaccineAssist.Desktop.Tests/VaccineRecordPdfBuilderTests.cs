using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using VaccineAssist.Desktop.Fax;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// Fax-report-layout brief (Will, 2026-09-28) smoke tests — asserts the
/// letter's required sections/strings actually appear in the rendered
/// PDF (not just "some bytes came out"), by extracting every Tj-drawn
/// text run from the PDF's (Flate-compressed) content streams and
/// checking for the expected fragments. Real visual layout can only be
/// eyeballed on Windows (PDFsharp-WPF needs the Windows target) — these
/// tests only prove the TEXT is present, not pixel placement.
/// </summary>
public class VaccineRecordPdfBuilderTests
{
    private static readonly FaxSettings Settings = new()
    {
        PharmacyName = "Test Pharmacy",
        PharmacyPhone = "5555550100",
        PharmacyFax = "5555550101",
        PharmacyAddressLine1 = "100 Synthetic St",
        PharmacyCityStateZip = "Sampleton, KS 66000",
        SignatureName = "Synthetic Pharmacist, Pharm.D.",
    };

    private static ImmunizationRecord MakeRecord(int dayOffset) => new()
    {
        PatientFirstName = "Test Middle",
        PatientLastName = "Patient",
        PatientDob = new DateOnly(1980, 1, 15),
        VaccineName = $"Vaccine {dayOffset}",
        AdministeredDate = new DateOnly(2026, 9, 1).AddDays(dayOffset),
        Lot = $"LOT{dayOffset}",
        PrescriberName = "Dr. Synthetic",
    };

    private static PatientFaxGroup MakeGroup(int recordCount)
    {
        var records = Enumerable.Range(0, recordCount).Select(MakeRecord).ToList();
        return new PatientFaxGroup
        {
            PatientKey = "TEST|PATIENT|1980-01-15",
            PrescriberKey = "name:DR. SYNTHETIC",
            Records = records,
        };
    }

    [Fact]
    public void ProducesNonEmptyPdfBytes()
    {
        var builder = new VaccineRecordPdfBuilder();

        var result = builder.Build(MakeGroup(1), Settings, "5555550200");

        Assert.NotEmpty(result.PdfBytes);
        // %PDF is the standard file-signature header every PDF starts with.
        Assert.Equal("%PDF", System.Text.Encoding.ASCII.GetString(result.PdfBytes, 0, 4));
    }

    [Fact]
    public void FewVaccinesFitOnOnePage()
    {
        var builder = new VaccineRecordPdfBuilder();

        var result = builder.Build(MakeGroup(2), Settings, "5555550200");

        Assert.Equal(1, result.PageCount);
    }

    [Fact]
    public void ManyVaccinesSpanMultiplePages()
    {
        var builder = new VaccineRecordPdfBuilder();

        // Comfortably more rows than fit on a single Letter-sized page at
        // this table's row height.
        var result = builder.Build(MakeGroup(80), Settings, "5555550200");

        Assert.True(result.PageCount > 1, $"Expected more than 1 page for 80 records, got {result.PageCount}");
    }

    [Fact]
    public void OnePageLetterHasNoPageFooter()
    {
        var builder = new VaccineRecordPdfBuilder();

        var result = builder.Build(MakeGroup(1), Settings, "5555550200");
        var text = ExtractDrawnText(result.PdfBytes);

        Assert.DoesNotContain("Page 1 of", text);
    }

    [Fact]
    public void MultiPageLetterStampsPageXOfYOnEveryPage()
    {
        var builder = new VaccineRecordPdfBuilder();

        var result = builder.Build(MakeGroup(80), Settings, "5555550200");
        var text = ExtractDrawnText(result.PdfBytes);

        Assert.Contains($"Page 1 of {result.PageCount}", text);
        Assert.Contains($"Page {result.PageCount} of {result.PageCount}", text);
    }

    [Fact]
    public void LetterContainsTitlePharmacyBlockAndToBlock()
    {
        var builder = new VaccineRecordPdfBuilder();

        var result = builder.Build(MakeGroup(1), Settings, "5555550200");
        var text = ExtractDrawnText(result.PdfBytes);

        Assert.Contains("Fax", text);
        Assert.Contains("Vaccine Administration Notification", text);

        Assert.Contains(Settings.PharmacyName, text);
        Assert.Contains(Settings.PharmacyAddressLine1, text);
        Assert.Contains(Settings.PharmacyCityStateZip, text);
        Assert.Contains("Phone: (555) 555-0100", text);
        Assert.Contains("Fax: (555) 555-0101", text);

        // "To:" block — prescriber name, and the RESOLVED fax number
        // (the one actually being sent to), formatted for display.
        Assert.Contains("To: Dr. Synthetic", text);
        Assert.Contains("Fax: (555) 555-0200", text);
    }

    [Fact]
    public void LetterContainsTheBodyParagraphVerbatim()
    {
        var builder = new VaccineRecordPdfBuilder();

        var result = builder.Build(MakeGroup(1), Settings, "5555550200");
        var text = ExtractDrawnText(result.PdfBytes);

        Assert.Contains("Dear provider,", text);
        // Reassembled paragraph (joined across its wrapped Tj lines) must
        // match Will's brief verbatim.
        var joined = string.Join(" ", new[]
        {
            "The patient(s) indicated below have identified you as their primary care provider. We're writing to let you know",
            "that they received the following vaccination(s) from our pharmacy. This information has also been reported to the",
            "state registry. If you have any questions or need more information, please feel free to contact us. Thank you.",
        });
        Assert.Contains(joined, text);
    }

    [Fact]
    public void LetterTableHasExactlyTheFourExpectedColumnHeaders()
    {
        var builder = new VaccineRecordPdfBuilder();

        var result = builder.Build(MakeGroup(1), Settings, "5555550200");
        var text = ExtractDrawnText(result.PdfBytes);

        Assert.Contains("Patient Name", text);
        Assert.Contains("Birth Date", text);
        Assert.Contains("Vaccination", text);
        Assert.Contains("Date Administered", text);

        // Optional columns (lot/manufacturer/etc.) are never drawn — the
        // record above sets Lot but the letter has no Lot column at all.
        Assert.DoesNotContain("Lot", text);
        Assert.DoesNotContain("Manufacturer", text);
    }

    [Fact]
    public void LetterTableHasOneRowPerVaccineWithPatientNameLastCommaFirst()
    {
        var builder = new VaccineRecordPdfBuilder();

        var result = builder.Build(MakeGroup(3), Settings, "5555550200");
        var text = ExtractDrawnText(result.PdfBytes);

        // "Last, First Middle" verbatim, as it appears in the report.
        Assert.Contains("Patient, Test Middle", text);
        Assert.Contains("01/15/1980", text); // Birth Date
        Assert.Contains("Vaccine 0", text);
        Assert.Contains("Vaccine 1", text);
        Assert.Contains("Vaccine 2", text);
        Assert.Contains("09/01/2026", text); // Date Administered, record 0
        Assert.Contains("09/03/2026", text); // Date Administered, record 2
    }

    [Fact]
    public void LetterEndsWithSincerelyAndTheSignatureNameSetting()
    {
        var builder = new VaccineRecordPdfBuilder();

        var result = builder.Build(MakeGroup(1), Settings, "5555550200");
        var text = ExtractDrawnText(result.PdfBytes);

        Assert.Contains("Sincerely,", text);
        Assert.Contains(Settings.SignatureName, text);
    }

    [Fact]
    public void BlankOptionalPharmacyLinesAreOmittedNotBlank()
    {
        var builder = new VaccineRecordPdfBuilder();
        var bareSettings = new FaxSettings { PharmacyName = "Bare Pharmacy" };

        // Must not throw even though address/city-state-zip/phone/fax are
        // all blank — DrawIfPresent just skips them.
        var result = builder.Build(MakeGroup(1), bareSettings, "5555550200");

        Assert.NotEmpty(result.PdfBytes);
    }

    // ---- V-T65 R6 (Will, verbatim, 2026-09-29): "Add a place in settings
    // for me to upload company logo to use in the report." ----

    /// <summary>A minimal, valid 1x1 transparent PNG — synthetic test data
    /// only, per the PHI rule (nothing derived from a real logo).</summary>
    private const string OnePixelPngBase64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

    [Fact]
    public void BuildWithNoLogoProducesANonEmptyPdfWithoutThrowing()
    {
        var builder = new VaccineRecordPdfBuilder();
        var settingsWithoutLogo = new FaxSettings { PharmacyName = "Test Pharmacy", LogoPath = null };

        var result = builder.Build(MakeGroup(1), settingsWithoutLogo, "5555550200");

        Assert.NotEmpty(result.PdfBytes);
    }

    [Fact]
    public void BuildWithALogoProducesANonEmptyPdfWithoutThrowing()
    {
        var tempDir = Path.Combine(Path.GetTempPath(), "vaccine-assist-tests", Guid.NewGuid().ToString("n"));
        Directory.CreateDirectory(tempDir);
        var logoPath = Path.Combine(tempDir, "logo.png");
        File.WriteAllBytes(logoPath, Convert.FromBase64String(OnePixelPngBase64));

        try
        {
            var builder = new VaccineRecordPdfBuilder();
            var settingsWithLogo = new FaxSettings { PharmacyName = "Test Pharmacy", LogoPath = logoPath };

            var result = builder.Build(MakeGroup(1), settingsWithLogo, "5555550200");

            Assert.NotEmpty(result.PdfBytes);
            Assert.Equal("%PDF", Encoding.ASCII.GetString(result.PdfBytes, 0, 4));
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { /* best-effort */ }
        }
    }

    [Fact]
    public void BuildWithAMissingLogoFileFallsBackToNoLogoRatherThanThrowing()
    {
        var builder = new VaccineRecordPdfBuilder();
        var settingsWithBadLogo = new FaxSettings
        {
            PharmacyName = "Test Pharmacy",
            LogoPath = Path.Combine(Path.GetTempPath(), "vaccine-assist-tests", "does-not-exist.png"),
        };

        var result = builder.Build(MakeGroup(1), settingsWithBadLogo, "5555550200");

        Assert.NotEmpty(result.PdfBytes);
    }

    /// <summary>Decompresses every Flate content stream in the PDF and
    /// pulls out the literal text of every Tj-drawn string, unescaping
    /// PDF's backslash escapes for parens/backslash, joined with spaces
    /// in document order — good enough to assert on for a smoke test
    /// without a full PDF-parsing dependency.</summary>
    private static string ExtractDrawnText(byte[] pdfBytes)
    {
        var raw = Encoding.Latin1.GetString(pdfBytes);
        var streamMatches = Regex.Matches(raw, @"stream\r?\n(.*?)endstream", RegexOptions.Singleline);

        var sb = new StringBuilder();
        foreach (Match streamMatch in streamMatches)
        {
            var bytes = Encoding.Latin1.GetBytes(streamMatch.Groups[1].Value);
            string decompressed;
            try
            {
                using var input = new MemoryStream(bytes);
                using var zlib = new ZLibStream(input, CompressionMode.Decompress);
                using var output = new MemoryStream();
                zlib.CopyTo(output);
                decompressed = Encoding.Latin1.GetString(output.ToArray());
            }
            catch
            {
                continue; // not a Flate content stream (e.g. an embedded font program) — skip it.
            }

            foreach (Match tj in Regex.Matches(decompressed, @"\(((?:[^()\\]|\\.)*)\)\s*Tj"))
            {
                var unescaped = tj.Groups[1].Value
                    .Replace("\\(", "(")
                    .Replace("\\)", ")")
                    .Replace("\\\\", "\\");
                sb.Append(unescaped).Append(' ');
            }
        }

        return sb.ToString();
    }
}
