using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;

namespace VaccineAssist.Desktop.Logging;

/// <summary>
/// Tiny append-only file logger at %AppData%\VaccineAssist\logs\app.log —
/// no framework (Serilog/NLog etc.), matching this app's dependency-light
/// style (see App.xaml.cs's composition-root comment). Backs two things
/// added for Will's 2026-08-19/20 crash + data-entry feedback:
///   1. App.xaml.cs's global unhandled-exception handlers write a crash
///      record here before showing the "something went wrong" dialog, so
///      a crash Will hits leaves a trail even though nobody's watching a
///      debugger.
///   2. The data-entry popup's "Copy logs" button (V-T3 item 4: "make a
///      way to copy those logs to send to you") reads recent lines back
///      out and puts them on the clipboard — covers PioneerRx
///      window-detection misses (FocusPioneerWindowStep logs what windows
///      WERE found here, not just "failed") as well as crashes.
///
/// Every public method is try/catch-swallowed internally: a logger that
/// itself throws (disk full, locked file, no permissions) must never be
/// the thing that crashes the app or blocks a command handler — see
/// AsyncRelayCommand.Execute's catch clause, which calls into here.
///
/// NO PHI: callers must only ever pass operational text (exception
/// messages/stack traces, step names, window title PREFIXES before any
/// " - " separator — see PioneerRxAttachment — process/class names).
/// Never a patient name, DOB, or Rx number.
/// </summary>
public static class AppFileLog
{
    private const long MaxFileSizeBytes = 2 * 1024 * 1024; // 2 MB, then roll to .old (one generation)

    private static readonly object SyncRoot = new();

    private static string LogFilePath
    {
        get
        {
            var dir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "VaccineAssist", "logs");
            return Path.Combine(dir, "app.log");
        }
    }

    /// <summary>Appends one timestamped line. Never throws.</summary>
    public static void Log(string message)
    {
        try
        {
            lock (SyncRoot)
            {
                var path = LogFilePath;
                var dir = Path.GetDirectoryName(path)!;
                if (!Directory.Exists(dir))
                {
                    Directory.CreateDirectory(dir);
                }

                RollIfTooLarge(path);

                var line = $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff} {message}{Environment.NewLine}";
                File.AppendAllText(path, line, Encoding.UTF8);
            }
        }
        catch
        {
            // Logging must never be the reason the app crashes or a
            // command fails — see class doc comment.
        }
    }

    /// <summary>Convenience for exception logging — includes the exception
    /// type, message, and stack trace (never any argument/state that might
    /// carry PHI). <paramref name="context"/> is a short label for where
    /// this came from (e.g. "AsyncRelayCommand", "DispatcherUnhandledException").</summary>
    public static void LogException(string context, Exception ex)
    {
        Log($"[{context}] {ex.GetType().Name}: {ex.Message}{Environment.NewLine}{ex.StackTrace}");
    }

    /// <summary>Reads back the last <paramref name="maxLines"/> lines for
    /// the "Copy logs" button. Returns an empty string (never throws) if
    /// the log file doesn't exist yet or can't be read.</summary>
    public static string ReadRecentLines(int maxLines = 200)
    {
        try
        {
            lock (SyncRoot)
            {
                var path = LogFilePath;
                if (!File.Exists(path)) return "";

                var lines = File.ReadAllLines(path);
                var recent = lines.Length <= maxLines ? lines : lines[^maxLines..];
                return string.Join(Environment.NewLine, recent);
            }
        }
        catch
        {
            return "";
        }
    }

    private static void RollIfTooLarge(string path)
    {
        try
        {
            var info = new FileInfo(path);
            if (!info.Exists || info.Length < MaxFileSizeBytes) return;

            var oldPath = path + ".old";
            if (File.Exists(oldPath))
            {
                File.Delete(oldPath);
            }
            File.Move(path, oldPath);
        }
        catch
        {
            // Best-effort rotation only — an oversized log is a nuisance,
            // not something worth risking a crash over.
        }
    }
}
