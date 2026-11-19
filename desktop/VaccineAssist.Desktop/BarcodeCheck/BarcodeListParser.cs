using System.Globalization;
using System.IO;
using System.Text.RegularExpressions;
using ClosedXML.Excel;
using CsvHelper;
using CsvHelper.Configuration;

namespace VaccineAssist.Desktop.BarcodeCheck;

/// <summary>What a barcode list file contained: the numbers (as digit text)
/// plus how many first-column cells were written in scientific notation
/// ("1.23E+11" — a long number Excel already rounded, so its digits are
/// gone and it cannot be matched; surfaced so the window can warn).</summary>
public sealed record BarcodeListContents(IReadOnlyList<string> Numbers, int ScientificNotationCount);

/// <summary>The file can't be read as a barcode list; Message is plain
/// text safe to show to the pharmacist (it never contains file
/// contents).</summary>
public sealed class BarcodeListException : Exception
{
    public BarcodeListException(string message, Exception? inner = null) : base(message, inner)
    {
    }
}

/// <summary>
/// Reads the first column of a CSV or first sheet of an .xlsx as a list of
/// numbers (Will, 2026-11-18: "1 column of numbers"). Everything is read in
/// memory and returned — nothing is logged, cached, or written anywhere,
/// since the file may hold Rx numbers.
///
/// Numbers stay TEXT digits so leading zeros and long (12+ digit) barcodes
/// survive. Blank cells, a header row, and anything that is not a plain
/// number are skipped. An Excel numeric cell becomes its integer digits
/// (never "1.23E+11" or "123.0"). Reuses ClosedXML and CsvHelper, which
/// the fax report import already ships, so there is no new package.
/// </summary>
public static class BarcodeListParser
{
    private static readonly Regex DigitsOnly = new(@"^[0-9]+$", RegexOptions.Compiled);
    private static readonly Regex WholeNumberWithZeroFraction = new(@"^(?<int>[0-9]+)\.0+$", RegexOptions.Compiled);
    private static readonly Regex ScientificNotation = new(@"^[0-9]+(\.[0-9]+)?[eE][+-]?[0-9]+$", RegexOptions.Compiled);

    /// <summary>Largest integer a double stores exactly (2^53); beyond it a
    /// numeric Excel cell has already lost digits.</summary>
    private const double MaxExactDouble = 9007199254740992d;

    /// <summary>Turns one cell's text into digit text, or null when it is
    /// not a plain number (blank, header text, a decimal like "1.5").
    /// "123.0" (a whole number written with a zero fraction) gives "123".</summary>
    public static string? NormalizeCellText(string? raw)
    {
        if (raw is null)
        {
            return null;
        }

        var text = raw.Trim();
        if (text.Length == 0)
        {
            return null;
        }

        if (DigitsOnly.IsMatch(text))
        {
            return text;
        }

        var whole = WholeNumberWithZeroFraction.Match(text);
        return whole.Success ? whole.Groups["int"].Value : null;
    }

    /// <summary>Digit text for an Excel numeric cell value, or null when it
    /// is not a non-negative whole number that a double holds exactly.</summary>
    public static string? NormalizeNumber(double value)
    {
        if (double.IsNaN(value) || double.IsInfinity(value) || value < 0 || value > MaxExactDouble)
        {
            return null;
        }

        if (value != Math.Floor(value))
        {
            return null;
        }

        return value.ToString("F0", CultureInfo.InvariantCulture);
    }

    public static BarcodeListContents ParseCsv(TextReader reader)
    {
        var numbers = new List<string>();
        var scientific = 0;

        using var csv = new CsvReader(reader, new CsvConfiguration(CultureInfo.InvariantCulture)
        {
            HasHeaderRecord = false,
            BadDataFound = null,
            MissingFieldFound = null,
            DetectDelimiter = false,
            // Excel on some locales saves "a;b"; the first field is all
            // we read, and a plain comma split keeps a single-column file
            // (the real case) working either way.
            Delimiter = ",",
        });

        while (csv.Read())
        {
            string? field = null;
            if (csv.Parser.Count > 0)
            {
                field = csv.GetField(0);
            }

            AddCell(field, numbers, ref scientific);
        }

        return new BarcodeListContents(numbers, scientific);
    }

    public static BarcodeListContents ParseXlsx(Stream stream)
    {
        var numbers = new List<string>();
        var scientific = 0;

        using var workbook = new XLWorkbook(stream);
        var sheet = workbook.Worksheets.FirstOrDefault();
        var lastRow = sheet?.LastRowUsed()?.RowNumber() ?? 0;

        for (var row = 1; row <= lastRow; row++)
        {
            var cell = sheet!.Cell(row, 1);
            var value = cell.Value;

            if (value.IsNumber)
            {
                var digits = NormalizeNumber(value.GetNumber());
                if (digits is not null)
                {
                    numbers.Add(digits);
                }
            }
            else if (value.IsText)
            {
                AddCell(value.GetText(), numbers, ref scientific);
            }
        }

        return new BarcodeListContents(numbers, scientific);
    }

    /// <summary>Reads a .csv or .xlsx file fully in memory. Throws
    /// BarcodeListException with a plain message for a locked, missing,
    /// corrupt, or unsupported file.</summary>
    public static BarcodeListContents ParseFile(string filePath)
    {
        var extension = Path.GetExtension(filePath).ToLowerInvariant();
        if (extension == ".xls")
        {
            throw new BarcodeListException(
                "Old Excel (.xls) files can't be read. Open it in Excel and use Save As to make an .xlsx or .csv file.");
        }

        if (extension != ".csv" && extension != ".xlsx")
        {
            throw new BarcodeListException("Please choose a .csv or .xlsx file.");
        }

        byte[] bytes;
        try
        {
            // ReadWrite sharing: a file still open in Excel can be read.
            using var file = new FileStream(filePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            using var memory = new MemoryStream();
            file.CopyTo(memory);
            bytes = memory.ToArray();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw new BarcodeListException(
                "That file couldn't be opened. It may be open in another program, or you may not have access to it.", ex);
        }

        try
        {
            if (extension == ".csv")
            {
                using var reader = new StreamReader(new MemoryStream(bytes), detectEncodingFromByteOrderMarks: true);
                return ParseCsv(reader);
            }

            return ParseXlsx(new MemoryStream(bytes));
        }
        catch (Exception ex)
        {
            throw new BarcodeListException(
                extension == ".csv"
                    ? "That file couldn't be read as a CSV list of numbers."
                    : "That file couldn't be read as an Excel (.xlsx) workbook. It may be damaged or password protected.",
                ex);
        }
    }

    private static void AddCell(string? raw, List<string> numbers, ref int scientific)
    {
        var digits = NormalizeCellText(raw);
        if (digits is not null)
        {
            numbers.Add(digits);
        }
        else if (raw is not null && ScientificNotation.IsMatch(raw.Trim()))
        {
            scientific++;
        }
    }
}
