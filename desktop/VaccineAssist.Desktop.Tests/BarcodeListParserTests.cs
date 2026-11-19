using System.IO;
using ClosedXML.Excel;
using VaccineAssist.Desktop.BarcodeCheck;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>Barcode check list reading (synthetic numbers only).</summary>
public class BarcodeListParserTests
{
    private static BarcodeListContents Csv(string text) => BarcodeListParser.ParseCsv(new StringReader(text));

    private static MemoryStream Workbook(Action<IXLWorksheet> fill)
    {
        using var workbook = new XLWorkbook();
        fill(workbook.AddWorksheet("Sheet1"));
        var stream = new MemoryStream();
        workbook.SaveAs(stream);
        stream.Position = 0;
        return stream;
    }

    [Fact]
    public void CsvReadsFirstFieldPerLineAndIgnoresOtherColumns()
    {
        var result = Csv("1000000001,extra,more\n1000000002,x\n1000000003\n");
        Assert.Equal(new[] { "1000000001", "1000000002", "1000000003" }, result.Numbers);
    }

    [Fact]
    public void CsvSkipsNonNumericHeaderRowAndBlankLines()
    {
        var result = Csv("Barcode\n1000000001\n\n   \n1000000002\n");
        Assert.Equal(new[] { "1000000001", "1000000002" }, result.Numbers);
    }

    [Fact]
    public void CsvTrimsWhitespaceAndQuotes()
    {
        var result = Csv("  1000000001  \n\"1000000002\"\n");
        Assert.Equal(new[] { "1000000001", "1000000002" }, result.Numbers);
    }

    [Fact]
    public void CsvKeepsLeadingZerosAndLongNumbersAsText()
    {
        var result = Csv("000123456789\n123456789012345\n");
        Assert.Equal(new[] { "000123456789", "123456789012345" }, result.Numbers);
    }

    [Fact]
    public void CsvWholeNumberWithZeroFractionLosesTheFraction()
    {
        var result = Csv("100000000001.0\n100000000002.00\n12.5\n");
        Assert.Equal(new[] { "100000000001", "100000000002" }, result.Numbers);
    }

    [Fact]
    public void CsvCountsScientificNotationCellsInsteadOfSilentlyDroppingThem()
    {
        var result = Csv("Barcode\n1.23457E+11\n1000000001\n");
        Assert.Equal(new[] { "1000000001" }, result.Numbers);
        Assert.Equal(1, result.ScientificNotationCount);
    }

    [Fact]
    public void CsvWithByteOrderMarkStillReadsTheFirstRow()
    {
        var bytes = new byte[] { 0xEF, 0xBB, 0xBF }.Concat(System.Text.Encoding.UTF8.GetBytes("1000000001\n1000000002\n")).ToArray();
        using var reader = new StreamReader(new MemoryStream(bytes), detectEncodingFromByteOrderMarks: true);
        Assert.Equal(new[] { "1000000001", "1000000002" }, BarcodeListParser.ParseCsv(reader).Numbers);
    }

    [Fact]
    public void EmptyCsvGivesNoNumbers()
    {
        Assert.Empty(Csv("").Numbers);
    }

    [Fact]
    public void XlsxNumericCellsBecomeIntegerDigitsWithNoExponentOrDecimal()
    {
        using var stream = Workbook(s =>
        {
            s.Cell(1, 1).Value = "Barcode";
            s.Cell(2, 1).Value = 123456789012d;   // 12-digit number cell
            s.Cell(3, 1).Value = 4500d;
            s.Cell(4, 1).Value = 12.5d;           // not a whole number -> skipped
        });

        var result = BarcodeListParser.ParseXlsx(stream);

        Assert.Equal(new[] { "123456789012", "4500" }, result.Numbers);
    }

    [Fact]
    public void XlsxTextCellsKeepLeadingZerosAndSkipBlanks()
    {
        using var stream = Workbook(s =>
        {
            s.Cell(1, 1).Value = "000123456789";
            s.Cell(3, 1).Value = "  000987654321 ";
            s.Cell(4, 1).Value = "not a number";
        });

        var result = BarcodeListParser.ParseXlsx(stream);

        Assert.Equal(new[] { "000123456789", "000987654321" }, result.Numbers);
    }

    [Fact]
    public void XlsxReadsOnlyTheFirstColumnOfTheFirstSheet()
    {
        using var workbook = new XLWorkbook();
        var first = workbook.AddWorksheet("First");
        first.Cell(1, 1).Value = 111d;
        first.Cell(1, 2).Value = 222d;
        workbook.AddWorksheet("Second").Cell(1, 1).Value = 333d;
        using var stream = new MemoryStream();
        workbook.SaveAs(stream);
        stream.Position = 0;

        Assert.Equal(new[] { "111" }, BarcodeListParser.ParseXlsx(stream).Numbers);
    }

    [Fact]
    public void EmptyWorkbookGivesNoNumbers()
    {
        using var stream = Workbook(_ => { });
        Assert.Empty(BarcodeListParser.ParseXlsx(stream).Numbers);
    }

    [Theory]
    [InlineData(0d, "0")]
    [InlineData(1d, "1")]
    [InlineData(123456789012d, "123456789012")]
    [InlineData(9007199254740992d, "9007199254740992")]
    public void NormalizeNumberGivesPlainDigits(double value, string expected)
    {
        Assert.Equal(expected, BarcodeListParser.NormalizeNumber(value));
    }

    [Theory]
    [InlineData(-1d)]
    [InlineData(1.5d)]
    [InlineData(double.NaN)]
    [InlineData(1e300d)]
    public void NormalizeNumberRejectsNonIntegersAndHugeValues(double value)
    {
        Assert.Null(BarcodeListParser.NormalizeNumber(value));
    }

    [Fact]
    public void ParseFileReadsACsvFromDiskInMemory()
    {
        var path = Path.Combine(Path.GetTempPath(), $"barcode-test-{Guid.NewGuid():N}.csv");
        File.WriteAllText(path, "Barcode\n0012345678\n");
        try
        {
            Assert.Equal(new[] { "0012345678" }, BarcodeListParser.ParseFile(path).Numbers);
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void ParseFileReadsAFileThatAnotherProgramHasOpen()
    {
        var path = Path.Combine(Path.GetTempPath(), $"barcode-test-{Guid.NewGuid():N}.csv");
        File.WriteAllText(path, "1000000001\n");
        try
        {
            using var holder = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.ReadWrite);
            Assert.Equal(new[] { "1000000001" }, BarcodeListParser.ParseFile(path).Numbers);
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void ParseFileWithMissingFileThrowsPlainMessage()
    {
        var path = Path.Combine(Path.GetTempPath(), $"barcode-test-{Guid.NewGuid():N}.csv");
        var ex = Assert.Throws<BarcodeListException>(() => BarcodeListParser.ParseFile(path));
        Assert.DoesNotContain(path, ex.Message);
    }

    [Fact]
    public void ParseFileWithCorruptXlsxThrowsPlainMessage()
    {
        var path = Path.Combine(Path.GetTempPath(), $"barcode-test-{Guid.NewGuid():N}.xlsx");
        File.WriteAllText(path, "this is not a workbook");
        try
        {
            Assert.Throws<BarcodeListException>(() => BarcodeListParser.ParseFile(path));
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Theory]
    [InlineData(".xls")]
    [InlineData(".txt")]
    public void ParseFileRejectsUnsupportedExtensionsWithAMessage(string extension)
    {
        var ex = Assert.Throws<BarcodeListException>(() => BarcodeListParser.ParseFile("x" + extension));
        Assert.False(string.IsNullOrWhiteSpace(ex.Message));
    }
}
