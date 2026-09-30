using System.Collections.Generic;
using System.IO;
using PdfSharp;
using PdfSharp.Drawing;
using PdfSharp.Pdf;

namespace VaccineAssist.Desktop.Fax;

/// <summary>
/// Fax-report-layout brief (Will, 2026-09-28 — matches the current fax he
/// showed alongside a real Pioneer report export): builds a one-page
/// (more if many vaccines) vaccine-administration-notification LETTER,
/// top to bottom — "Fax" title + "Vaccine Administration Notification"
/// subtitle, pharmacy block (name/address/phone/fax from settings), "To:"
/// block (prescriber name + the fax number actually being sent to), the
/// body paragraph verbatim, a 4-column table (Patient Name / Birth Date /
/// Vaccination / Date Administered — one row per vaccine in the group),
/// "Sincerely," + a settings-configurable signature name. No cover page.
///
/// Deliberately just those 4 table columns, always — Pioneer's real
/// report (see FaxColumnMap's doc comment) never supplies lot/
/// manufacturer/dose/route/site/VIS-date/pharmacist/NPI, so there is no
/// current data to show in extra columns; if a future report ever
/// populates those optional ImmunizationRecord fields, extending the
/// table to show them is a follow-up, not implemented here (avoids
/// building untested variable-column layout for a case that doesn't
/// exist in Will's actual weekly workflow).
///
/// The "To:" block has no Phone line — there is no PrescriberPhone data
/// anywhere in this app yet (report has no such column, and
/// PrescriberDirectoryEntry doesn't store one either), so "Phone only if
/// known" always means "omit" today. Wiring an actual phone source in is
/// a separate follow-up.
///
/// Uses PDFsharp-WPF (see the csproj's own comment on why that package
/// specifically — standard fonts like Arial need no custom
/// IFontResolver on net8.0-windows with that build).
///
/// PDFsharp allows at most ONE live XGraphics per PdfPage at a time, so
/// the main pass never draws a footer — "Page x of y" (only when the
/// document ran to more than one page) is stamped in a SEPARATE final
/// pass over document.Pages, once the true page count is known, each
/// page's XGraphics opened/disposed in turn.
/// </summary>
public sealed class VaccineRecordPdfBuilder : IVaccineRecordPdfBuilder
{
    private const double MarginPoints = 40;

    /// <summary>V-T65 R6 (Will, verbatim, 2026-09-29): "it was coming
    /// across a little hazy on the fax I printed out" — bumped from 9pt
    /// alongside TableBodyFontSize below (a fax is rasterized at ~200dpi
    /// and loses small/thin detail); RowHeight grew to match so rows never
    /// overlap.</summary>
    private const double RowHeight = 22;

    private const double HeaderRowHeight = 20;

    /// <summary>Company logo (Fax settings, V-T65 R6): max box it's
    /// scaled into, aspect preserved — see the "To:"/title-block layout
    /// below.</summary>
    private const double MaxLogoWidth = 160;
    private const double MaxLogoHeight = 60;

    private static readonly string[] ColumnHeaders =
        { "Patient Name", "Birth Date", "Vaccination", "Date Administered" };

    private static readonly double[] ColumnWidths =
        { 172, 90, 180, 90 };

    // Will's current fax, reproduced verbatim (extracted from his own
    // example) — see class doc comment for why this is hardcoded rather
    // than measured/wrapped: it's an exact, already-approved 3-line break
    // of the brief's body paragraph at this page width/font, and keeping
    // it literal makes both the letter and its smoke test predictable.
    private static readonly string[] BodyParagraphLines =
    {
        "The patient(s) indicated below have identified you as their primary care provider. We're writing to let you know",
        "that they received the following vaccination(s) from our pharmacy. This information has also been reported to the",
        "state registry. If you have any questions or need more information, please feel free to contact us. Thank you.",
    };

    public VaccinePdfResult Build(PatientFaxGroup group, FaxSettings faxSettings, string resolvedFaxNumber)
    {
        var document = new PdfDocument();
        document.Info.Title = $"Vaccine Administration Notification - {group.PatientFullName}";

        var titleFont = new XFont("Arial", 22, XFontStyleEx.Bold);
        var subtitleFont = new XFont("Arial", 15, XFontStyleEx.Bold);
        var labelFont = new XFont("Arial", 11, XFontStyleEx.Bold);
        var bodyFont = new XFont("Arial", 11, XFontStyleEx.Regular);
        var tableHeaderFont = new XFont("Arial", 9, XFontStyleEx.Bold);
        // V-T65 R6 (Will, verbatim, 2026-09-29): "make the text on the
        // patient info rows easier to read ... it was coming across a
        // little hazy on the fax I printed out." Bumped from 9pt.
        var tableBodyFont = new XFont("Arial", 10.5, XFontStyleEx.Regular);
        var footerFont = new XFont("Arial", 8, XFontStyleEx.Italic);

        var page = NewPage(document);
        var gfx = XGraphics.FromPdfPage(page);
        var left = MarginPoints;
        var right = page.Width.Point - MarginPoints;
        var tableRight = left + ColumnWidths[0] + ColumnWidths[1] + ColumnWidths[2] + ColumnWidths[3];
        var bottomLimit = page.Height.Point - MarginPoints;

        var y = MarginPoints;

        // Company logo (Fax settings, V-T65 R6: "Add a place in settings
        // for me to upload company logo") — top-left, max
        // MaxLogoWidth x MaxLogoHeight with aspect preserved; the title
        // block shifts right of it. No logo (the default, and any bad/
        // missing logo file) -> textLeft stays `left` and logoBottomY
        // stays MarginPoints, so the layout below is byte-for-byte what it
        // was before this setting existed.
        var textLeft = left;
        var logoBottomY = MarginPoints;
        if (!string.IsNullOrWhiteSpace(faxSettings.LogoPath) && File.Exists(faxSettings.LogoPath))
        {
            try
            {
                using var logoImage = XImage.FromFile(faxSettings.LogoPath);
                var aspect = logoImage.PixelHeight > 0
                    ? (double)logoImage.PixelWidth / logoImage.PixelHeight
                    : 1.0;
                var drawWidth = MaxLogoWidth;
                var drawHeight = aspect > 0 ? drawWidth / aspect : MaxLogoHeight;
                if (drawHeight > MaxLogoHeight)
                {
                    drawHeight = MaxLogoHeight;
                    drawWidth = drawHeight * aspect;
                }

                gfx.DrawImage(logoImage, left, MarginPoints, drawWidth, drawHeight);
                textLeft = left + drawWidth + 16;
                logoBottomY = MarginPoints + drawHeight;
            }
            catch
            {
                // A moved/corrupt logo file must never block the fax
                // itself — fall back to the no-logo layout.
            }
        }

        // Title block.
        gfx.DrawString("Fax", titleFont, XBrushes.Black, new XPoint(textLeft, y + 18));
        y += 30;
        gfx.DrawString("Vaccine Administration Notification", subtitleFont, XBrushes.Black, new XPoint(textLeft, y + 14));
        y += 26;
        if (logoBottomY > MarginPoints)
        {
            y = Math.Max(y, logoBottomY) + 6;
        }
        gfx.DrawLine(XPens.Black, left, y, right, y);
        y += 20;

        // Pharmacy block.
        DrawIfPresent(gfx, labelFont, faxSettings.PharmacyName, left, ref y);
        DrawIfPresent(gfx, bodyFont, faxSettings.PharmacyAddressLine1, left, ref y);
        DrawIfPresent(gfx, bodyFont, faxSettings.PharmacyCityStateZip, left, ref y);
        DrawIfPresent(gfx, bodyFont, PhoneLine(faxSettings.PharmacyPhone), left, ref y);
        DrawIfPresent(gfx, bodyFont, FaxLine(faxSettings.PharmacyFax), left, ref y);
        y += 12;

        // "To:" block — the prescriber this specific fax is addressed to.
        gfx.DrawString($"To: {NullToDash(group.PrescriberName)}", labelFont, XBrushes.Black, new XPoint(left, y));
        y += 16;
        gfx.DrawString(FaxLine(resolvedFaxNumber), bodyFont, XBrushes.Black, new XPoint(left, y));
        y += 14;
        // No Phone line — see class doc comment (no PrescriberPhone data
        // source anywhere in this app yet).
        y += 18;

        // Body.
        gfx.DrawString("Dear provider,", bodyFont, XBrushes.Black, new XPoint(left, y));
        y += 20;
        foreach (var line in BodyParagraphLines)
        {
            gfx.DrawString(line, bodyFont, XBrushes.Black, new XPoint(left, y));
            y += 15;
        }
        y += 14;

        // Vaccine table.
        DrawTableHeader(gfx, tableHeaderFont, left, y);
        y += HeaderRowHeight;

        foreach (var record in group.Records)
        {
            if (y + RowHeight > bottomLimit)
            {
                gfx.Dispose();

                page = NewPage(document);
                gfx = XGraphics.FromPdfPage(page);
                y = MarginPoints;
                DrawTableHeader(gfx, tableHeaderFont, left, y);
                y += HeaderRowHeight;
            }

            DrawTableRow(gfx, tableBodyFont, left, y, new[]
            {
                $"{record.PatientLastName}, {record.PatientFirstName}",
                record.PatientDob is { } dob ? dob.ToString("MM/dd/yyyy") : "—",
                record.VaccineName,
                record.AdministeredDate.ToString("MM/dd/yyyy"),
            });
            y += RowHeight;
        }

        y += 24;

        // Signature block.
        if (y + 40 > bottomLimit)
        {
            gfx.Dispose();
            page = NewPage(document);
            gfx = XGraphics.FromPdfPage(page);
            y = MarginPoints;
        }
        gfx.DrawString("Sincerely,", bodyFont, XBrushes.Black, new XPoint(left, y));
        y += 22;
        gfx.DrawString(NullToDash(faxSettings.SignatureName), bodyFont, XBrushes.Black, new XPoint(left, y));

        gfx.Dispose();

        // Footer — "Page x of y" only when the letter actually ran past
        // one page (brief: never shown on a single-page letter). A
        // separate pass since the total page count isn't known until
        // every page above has been laid out, and PDFsharp only allows
        // one live XGraphics per page at a time.
        if (document.Pages.Count > 1)
        {
            for (var i = 0; i < document.Pages.Count; i++)
            {
                var footerPage = document.Pages[i];
                using var footerGfx = XGraphics.FromPdfPage(footerPage);
                footerGfx.DrawString(
                    $"Page {i + 1} of {document.Pages.Count}",
                    footerFont, XBrushes.Gray,
                    new XRect(left, footerPage.Height.Point - 26, tableRight - left, 16),
                    XStringFormats.BottomRight);
            }
        }

        using var stream = new MemoryStream();
        document.Save(stream, false);

        return new VaccinePdfResult(stream.ToArray(), document.Pages.Count);
    }

    private static PdfPage NewPage(PdfDocument document)
    {
        var page = document.AddPage();
        page.Size = PageSize.Letter;
        return page;
    }

    private static string PhoneLine(string? phone) =>
        string.IsNullOrWhiteSpace(phone) ? "" : $"Phone: {FaxNumberNormalizer.ToDisplay(phone)}";

    private static string FaxLine(string? fax) =>
        string.IsNullOrWhiteSpace(fax) ? "" : $"Fax: {FaxNumberNormalizer.ToDisplay(fax)}";

    /// <summary>Draws one line and advances y ONLY when it has content —
    /// a blank pharmacy address/phone/fax setting just leaves that line
    /// out of the block entirely rather than printing an empty line.</summary>
    private static void DrawIfPresent(XGraphics gfx, XFont font, string text, double left, ref double y)
    {
        if (string.IsNullOrWhiteSpace(text)) return;
        gfx.DrawString(text, font, XBrushes.Black, new XPoint(left, y));
        y += 15;
    }

    private static void DrawTableHeader(XGraphics gfx, XFont font, double left, double y)
    {
        var totalWidth = ColumnWidths[0] + ColumnWidths[1] + ColumnWidths[2] + ColumnWidths[3];

        // Shaded header row (Will's brief: "header row shaded") — a FILL,
        // not a text-adjacent stroke, so it stays light gray even though
        // strokes/text below are black (V-T65 R6: a fax loses thin/light
        // detail, but a shaded background block survives fine).
        gfx.DrawRectangle(XBrushes.LightGray, new XRect(left, y, totalWidth, HeaderRowHeight));

        var x = left;
        for (var i = 0; i < ColumnHeaders.Length; i++)
        {
            // Column headers are bold + black (V-T65 R6: "make the column
            // header bold" — font is already XFontStyleEx.Bold, see Build).
            gfx.DrawString(ColumnHeaders[i], font, XBrushes.Black, new XPoint(x + 4, y + 14));
            x += ColumnWidths[i];
        }

        // V-T65 R6 (Will, verbatim: "avoid ... thin hairlines under text";
        // a fax is rasterized at ~200dpi and loses light strokes) — was
        // XPens.Gray.
        gfx.DrawRectangle(XPens.Black, new XRect(left, y, totalWidth, HeaderRowHeight));
    }

    private static void DrawTableRow(XGraphics gfx, XFont font, double left, double y, IReadOnlyList<string> cells)
    {
        var totalWidth = ColumnWidths[0] + ColumnWidths[1] + ColumnWidths[2] + ColumnWidths[3];
        var x = left;
        for (var i = 0; i < cells.Count && i < ColumnWidths.Length; i++)
        {
            // Body text is black (V-T65 R6: "make sure the font color is
            // black at least" — was already XBrushes.Black; font just grew
            // to 10.5pt, see Build).
            gfx.DrawString(Truncate(cells[i]), font, XBrushes.Black, new XPoint(x + 4, y + 15));
            x += ColumnWidths[i];
        }
        // V-T65 R6 (Will, verbatim: "avoid ... thin hairlines under
        // text") — was XPens.LightGray, which a ~200dpi fax loses.
        gfx.DrawLine(XPens.Black, left, y + RowHeight, left + totalWidth, y + RowHeight);
    }

    /// <summary>Cheap length guard so an unexpectedly long report value
    /// can't overrun into the next column — real wrapping isn't worth the
    /// complexity for a table this narrow.</summary>
    private static string Truncate(string value) => value.Length <= 30 ? value : value[..29] + "…";

    private static string NullToDash(string? value) => string.IsNullOrWhiteSpace(value) ? "—" : value;
}
