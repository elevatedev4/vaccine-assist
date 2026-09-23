using PdfSharp;
using PdfSharp.Drawing;
using PdfSharp.Pdf;

namespace VaccineAssist.Desktop.Fax;

/// <summary>
/// Will's brief: "one page (more if many vaccines): header 'Immunization
/// Administration Record — Orchards Drug' (pharmacy name/phone/fax from
/// settings), patient block (name, DOB), a table of vaccines given (name,
/// date, lot, manufacturer, dose, route/site, VIS date, pharmacist),
/// prescriber block, footer 'Please add to the patient's immunization
/// record. Questions: <pharmacy phone>'. No cover page."
///
/// Uses PDFsharp-WPF (see the csproj's own comment on why that package
/// specifically — standard fonts like Arial need no custom
/// IFontResolver on net8.0-windows with that build).
/// </summary>
public sealed class VaccineRecordPdfBuilder : IVaccineRecordPdfBuilder
{
    private const double MarginPoints = 40;
    private const double RowHeight = 16;
    private const double HeaderRowHeight = 18;

    private static readonly string[] ColumnHeaders =
        { "Vaccine", "Date", "Lot", "Manufacturer", "Dose", "Route/Site", "VIS date", "Pharmacist" };

    private static readonly double[] ColumnWidths =
        { 105, 55, 55, 90, 45, 70, 60, 70 };

    public VaccinePdfResult Build(PatientFaxGroup group, FaxSettings faxSettings)
    {
        var document = new PdfDocument();
        document.Info.Title = $"Immunization Record - {group.PatientFullName}";

        var page = NewPage(document);
        var gfx = XGraphics.FromPdfPage(page);

        var headerFont = new XFont("Arial", 15, XFontStyleEx.Bold);
        var labelFont = new XFont("Arial", 10, XFontStyleEx.Bold);
        var bodyFont = new XFont("Arial", 10, XFontStyleEx.Regular);
        var tableHeaderFont = new XFont("Arial", 8, XFontStyleEx.Bold);
        var tableBodyFont = new XFont("Arial", 8, XFontStyleEx.Regular);
        var footerFont = new XFont("Arial", 8, XFontStyleEx.Italic);

        var y = MarginPoints;
        var left = MarginPoints;
        var right = page.Width.Point - MarginPoints;

        // Header — pharmacy identity, no cover page: this IS page 1.
        gfx.DrawString($"Immunization Administration Record — {NullToDash(faxSettings.PharmacyName)}", headerFont, XBrushes.Black, new XPoint(left, y));
        y += 20;
        gfx.DrawString($"Phone: {NullToDash(faxSettings.PharmacyPhone)}    Fax: {NullToDash(faxSettings.PharmacyFax)}", bodyFont, XBrushes.Black, new XPoint(left, y));
        y += 24;

        // Patient block
        gfx.DrawString("Patient", labelFont, XBrushes.Black, new XPoint(left, y));
        y += 15;
        gfx.DrawString($"Name: {group.PatientFullName}", bodyFont, XBrushes.Black, new XPoint(left, y));
        y += 14;
        gfx.DrawString($"DOB: {(group.PatientDob is { } dob ? dob.ToString("MM/dd/yyyy") : "(not on file)")}", bodyFont, XBrushes.Black, new XPoint(left, y));
        y += 22;

        // Vaccine table
        gfx.DrawString("Vaccines administered", labelFont, XBrushes.Black, new XPoint(left, y));
        y += 6;
        y += HeaderRowHeight; // reserve space; DrawTableHeader draws into it below
        DrawTableHeader(gfx, tableHeaderFont, left, y - HeaderRowHeight);

        foreach (var record in group.Records)
        {
            if (y + RowHeight > page.Height.Point - 90)
            {
                page = NewPage(document);
                gfx = XGraphics.FromPdfPage(page);
                y = MarginPoints;
                y += HeaderRowHeight;
                DrawTableHeader(gfx, tableHeaderFont, left, y - HeaderRowHeight);
            }

            DrawTableRow(gfx, tableBodyFont, left, y, new[]
            {
                record.VaccineName,
                record.AdministeredDate.ToString("MM/dd/yyyy"),
                record.Lot ?? "",
                record.Manufacturer ?? "",
                record.Dose ?? "",
                JoinRouteSite(record.Route, record.Site),
                record.VisDate is { } vis ? vis.ToString("MM/dd/yyyy") : "",
                record.Pharmacist ?? "",
            });
            y += RowHeight;
        }

        y += 16;

        // Prescriber block
        if (y + 60 > page.Height.Point - 90)
        {
            page = NewPage(document);
            gfx = XGraphics.FromPdfPage(page);
            y = MarginPoints;
        }
        gfx.DrawString("Prescriber", labelFont, XBrushes.Black, new XPoint(left, y));
        y += 15;
        gfx.DrawString($"Name: {NullToDash(group.PrescriberName)}", bodyFont, XBrushes.Black, new XPoint(left, y));
        y += 14;
        gfx.DrawString($"NPI: {NullToDash(group.PrescriberNpi)}", bodyFont, XBrushes.Black, new XPoint(left, y));

        // Footer — on every page, drawn last so it always lands at the
        // bottom regardless of how many pages the table above spanned.
        foreach (var pdfPage in document.Pages.Cast<PdfPage>())
        {
            var footerGfx = XGraphics.FromPdfPage(pdfPage);
            var footerText = $"Please add to the patient's immunization record. Questions: {NullToDash(faxSettings.PharmacyPhone)}";
            footerGfx.DrawString(footerText, footerFont, XBrushes.Gray,
                new XRect(left, pdfPage.Height.Point - 30, right - left, 20),
                XStringFormats.BottomLeft);
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

    private static void DrawTableHeader(XGraphics gfx, XFont font, double left, double y)
    {
        var x = left;
        for (var i = 0; i < ColumnHeaders.Length; i++)
        {
            gfx.DrawString(ColumnHeaders[i], font, XBrushes.Black, new XPoint(x + 2, y + 12));
            x += ColumnWidths[i];
        }
        gfx.DrawLine(XPens.Black, left, y + HeaderRowHeight, x, y + HeaderRowHeight);
    }

    private static void DrawTableRow(XGraphics gfx, XFont font, double left, double y, IReadOnlyList<string> cells)
    {
        var x = left;
        for (var i = 0; i < cells.Count && i < ColumnWidths.Length; i++)
        {
            gfx.DrawString(Truncate(cells[i]), font, XBrushes.Black, new XPoint(x + 2, y + 11));
            x += ColumnWidths[i];
        }
        gfx.DrawLine(XPens.LightGray, left, y + RowHeight, x, y + RowHeight);
    }

    /// <summary>Cheap length guard so an unexpectedly long report value
    /// (a free-text "Site" entry, say) can't overrun into the next
    /// column — real wrapping isn't worth the complexity for a table this
    /// narrow.</summary>
    private static string Truncate(string value) => value.Length <= 22 ? value : value[..21] + "…";

    private static string JoinRouteSite(string? route, string? site)
    {
        if (string.IsNullOrWhiteSpace(route) && string.IsNullOrWhiteSpace(site)) return "";
        if (string.IsNullOrWhiteSpace(site)) return route!;
        if (string.IsNullOrWhiteSpace(route)) return site!;
        return $"{route}/{site}";
    }

    private static string NullToDash(string? value) => string.IsNullOrWhiteSpace(value) ? "—" : value;
}
