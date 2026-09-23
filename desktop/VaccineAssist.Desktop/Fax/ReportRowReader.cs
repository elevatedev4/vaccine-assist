using System.Globalization;
using ClosedXML.Excel;
using CsvHelper;
using CsvHelper.Configuration;

namespace VaccineAssist.Desktop.Fax;

/// <summary>Headers (in file order) plus every data row, both as raw
/// strings — the shared shape ReportImporter's header validation and
/// ReportRowParser both work from, regardless of which file format
/// produced it.</summary>
public sealed record ReportFileContents(IReadOnlyList<string> Headers, IReadOnlyList<ReportRow> Rows);

/// <summary>
/// Reads a *.csv or *.xlsx immunization report into ReportFileContents.
/// Every cell is read as plain text (CsvHelper's raw fields; ClosedXML's
/// Cell.GetString(), which already formats a date cell using its
/// number-format string) — ReportRowParser.TryParseDate is tolerant of
/// both a formatted date string and a raw Excel serial number, so this
/// stays simple rather than needing per-column type detection here.
/// </summary>
public static class ReportRowReader
{
    public static ReportFileContents ReadCsv(string filePath)
    {
        using var reader = new StreamReader(filePath);
        using var csv = new CsvReader(reader, new CsvConfiguration(CultureInfo.InvariantCulture)
        {
            HeaderValidated = null,
            MissingFieldFound = null,
        });

        if (!csv.Read() || !csv.ReadHeader() || csv.HeaderRecord is null)
        {
            return new ReportFileContents(Array.Empty<string>(), Array.Empty<ReportRow>());
        }

        var headers = csv.HeaderRecord.ToList();
        var rows = new List<ReportRow>();
        while (csv.Read())
        {
            var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var header in headers)
            {
                values[header] = csv.GetField(header) ?? "";
            }
            rows.Add(new ReportRow(values));
        }

        return new ReportFileContents(headers, rows);
    }

    public static ReportFileContents ReadXlsx(string filePath)
    {
        using var workbook = new XLWorkbook(filePath);
        var sheet = workbook.Worksheets.First();
        var usedRange = sheet.RangeUsed();
        if (usedRange is null)
        {
            return new ReportFileContents(Array.Empty<string>(), Array.Empty<ReportRow>());
        }

        var allRows = usedRange.RowsUsed().ToList();
        if (allRows.Count == 0)
        {
            return new ReportFileContents(Array.Empty<string>(), Array.Empty<ReportRow>());
        }

        var headerRow = allRows[0];
        var columnCount = usedRange.ColumnCount();
        var headers = new List<string>();
        for (var c = 1; c <= columnCount; c++)
        {
            headers.Add(headerRow.Cell(c).GetString().Trim());
        }

        var rows = new List<ReportRow>();
        for (var i = 1; i < allRows.Count; i++)
        {
            var dataRow = allRows[i];
            var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            for (var c = 0; c < headers.Count; c++)
            {
                // 1-based column-within-row index — matches headerRow's
                // own column span since both come from the same usedRange.
                values[headers[c]] = dataRow.Cell(c + 1).GetString();
            }
            rows.Add(new ReportRow(values));
        }

        return new ReportFileContents(headers, rows);
    }

    public static ReportFileContents Read(string filePath)
    {
        var extension = Path.GetExtension(filePath).ToLowerInvariant();
        return extension switch
        {
            ".csv" => ReadCsv(filePath),
            ".xlsx" => ReadXlsx(filePath),
            _ => throw new NotSupportedException($"Unsupported report file extension: {extension}"),
        };
    }
}
