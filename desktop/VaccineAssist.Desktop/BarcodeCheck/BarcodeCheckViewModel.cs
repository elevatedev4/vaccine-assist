using System.IO;
using VaccineAssist.Desktop.Common;
using VaccineAssist.Desktop.Logging;

namespace VaccineAssist.Desktop.BarcodeCheck;

public enum BarcodeScanOutcome
{
    /// <summary>Nothing was scanned (empty box) or no list is loaded.</summary>
    None,
    Found,
    NotFound,
}

/// <summary>
/// State behind the "Barcode check" window (Will, 2026-11-18, MSG#1555):
/// load a one-column list of numbers, then for each scanned number say
/// whether it is in the list, with a short happy or error sound. The list,
/// file name and last result live only here, in memory; Clear() (called
/// when the window closes) wipes all of it, so a reopened window is always
/// blank. Nothing is saved, uploaded, or logged — the file may hold Rx
/// numbers, and not even the file name or count is written to the log.
/// </summary>
public sealed class BarcodeCheckViewModel : ObservableObject
{
    private const int MaxDisplayedScanLength = 40;

    private readonly BarcodeMatcher _matcher = new();
    private readonly IBarcodeSoundPlayer _sounds;

    private int _loadGeneration;
    private string _fileName = "";
    private int _loadedCount;
    private bool _hasList;
    private string _message = "";
    private BarcodeScanOutcome _lastOutcome = BarcodeScanOutcome.None;
    private string _lastScanned = "";

    public BarcodeCheckViewModel(IBarcodeSoundPlayer sounds)
    {
        _sounds = sounds ?? throw new ArgumentNullException(nameof(sounds));
    }

    /// <summary>Name only (no folder) of the loaded file; empty when none.</summary>
    public string FileName
    {
        get => _fileName;
        private set => SetProperty(ref _fileName, value);
    }

    /// <summary>"N numbers loaded", or empty when no list is loaded.</summary>
    public string LoadedSummary => _hasList
        ? $"{_loadedCount:N0} {(_loadedCount == 1 ? "number" : "numbers")} loaded"
        : "";

    /// <summary>True once a list with at least one number is loaded; the
    /// scan box is only usable then.</summary>
    public bool HasList
    {
        get => _hasList;
        private set
        {
            if (SetProperty(ref _hasList, value))
            {
                OnPropertyChanged(nameof(LoadedSummary));
            }
        }
    }

    /// <summary>A plain-language problem or warning for the pharmacist
    /// (bad file, nothing found, skipped scientific-notation cells).</summary>
    public string Message
    {
        get => _message;
        private set
        {
            if (SetProperty(ref _message, value))
            {
                OnPropertyChanged(nameof(HasMessage));
            }
        }
    }

    public bool HasMessage => _message.Length > 0;

    public BarcodeScanOutcome LastOutcome
    {
        get => _lastOutcome;
        private set
        {
            if (SetProperty(ref _lastOutcome, value))
            {
                OnPropertyChanged(nameof(ResultTitle));
            }
        }
    }

    /// <summary>"FOUND" / "NOT FOUND" / empty.</summary>
    public string ResultTitle => _lastOutcome switch
    {
        BarcodeScanOutcome.Found => "FOUND",
        BarcodeScanOutcome.NotFound => "NOT FOUND",
        _ => "",
    };

    /// <summary>The number from the last scan, shown under the result.</summary>
    public string LastScanned
    {
        get => _lastScanned;
        private set => SetProperty(ref _lastScanned, value);
    }

    /// <summary>Reads the file in memory and replaces any loaded list. A
    /// bad, locked, or empty file leaves the window blank with a plain
    /// message; this never throws.</summary>
    public async Task LoadFileAsync(string filePath)
    {
        var generation = ++_loadGeneration;
        ClearList();

        BarcodeListContents contents;
        try
        {
            contents = await Task.Run(() => BarcodeListParser.ParseFile(filePath)).ConfigureAwait(true);
        }
        catch (BarcodeListException ex)
        {
            if (generation == _loadGeneration)
            {
                Message = ex.Message;
            }

            return;
        }
        catch (Exception ex)
        {
            // Type name only; never the message or path (may hold Rx data).
            AppFileLog.Log($"[BarcodeCheck] unexpected load failure: {ex.GetType().Name}");
            if (generation == _loadGeneration)
            {
                Message = "That file couldn't be read.";
            }

            return;
        }

        if (generation != _loadGeneration)
        {
            return; // window was closed/cleared, or a newer file was chosen
        }

        var warning = contents.ScientificNotationCount > 0
            ? $"{contents.ScientificNotationCount:N0} cell(s) were skipped because Excel saved them in scientific notation "
              + "(like 1.23E+11), which loses the digits. Format that column as Text in Excel and save again."
            : "";

        if (contents.Numbers.Count == 0)
        {
            Message = "No numbers were found in the first column of that file."
                + (warning.Length > 0 ? " " + warning : "");
            return;
        }

        _matcher.Load(contents.Numbers);
        _loadedCount = contents.Numbers.Count;
        FileName = Path.GetFileName(filePath);
        Message = warning;
        HasList = true;
    }

    /// <summary>Checks one scanned number against the list, plays the
    /// matching sound, and records the result. Blank input (or no list
    /// loaded) does nothing. Instant: a HashSet lookup plus an
    /// asynchronous sound start, so back-to-back scans never wait.</summary>
    public BarcodeScanOutcome Scan(string? scanned)
    {
        var text = scanned?.Trim() ?? "";
        if (text.Length == 0 || !_hasList)
        {
            return BarcodeScanOutcome.None;
        }

        var found = _matcher.Contains(text);
        LastScanned = text.Length > MaxDisplayedScanLength ? text[..MaxDisplayedScanLength] + "…" : text;
        LastOutcome = found ? BarcodeScanOutcome.Found : BarcodeScanOutcome.NotFound;

        if (found)
        {
            _sounds.PlayFound();
        }
        else
        {
            _sounds.PlayNotFound();
        }

        return _lastOutcome;
    }

    /// <summary>Forgets everything: list, file name, message, last result.
    /// Called when the window closes, so it is always blank on reopen.</summary>
    public void Clear()
    {
        _loadGeneration++;
        ClearList();
    }

    private void ClearList()
    {
        _matcher.Clear();
        _loadedCount = 0;
        FileName = "";
        Message = "";
        LastScanned = "";
        LastOutcome = BarcodeScanOutcome.None;
        HasList = false;
        OnPropertyChanged(nameof(LoadedSummary));
    }
}
