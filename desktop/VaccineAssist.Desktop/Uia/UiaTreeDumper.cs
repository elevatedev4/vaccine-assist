using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using FlaUI.Core.AutomationElements;
using VaccineAssist.Desktop.Logging;

namespace VaccineAssist.Desktop.Uia;

/// <summary>
/// One-click UIA tree-dump collector (Will: "build something into the app
/// to help me get a Pioneer UIA tree dump, similar to what we did with
/// RxVerify") — unblocks PioneerEntryAutomation/TODO.md's stubbed
/// navigation/input steps, which need confirmed AutomationIds/control
/// shapes instead of guesses. Walks the ENTIRE UIA tree of the attached
/// PioneerRx window (see PioneerRxAttachment) and writes a timestamped,
/// human-readable text dump to %AppData%\VaccineAssist\uia-dumps\.
///
/// Modeled on rx-verify's overlay/RxVerifyOverlay/Uia/UiaTreeWalker.cs
/// DumpTree/DumpRecursive (control type, name, automation id, bounding
/// rect), extended with the extra columns this repo's field-lookup work
/// will actually need — ClassName, which UIA PATTERNS each element
/// supports (Invoke = buttons, Value/Text = text fields, Toggle =
/// checkboxes, SelectionItem/Selection = radio buttons / list items /
/// tabs, ExpandCollapse = combo boxes, Grid/GridItem/Table/TableItem =
/// data grids, Window = dialogs, Scroll/ScrollItem/RangeValue/Dock — not
/// FlaUI's full pattern set; add more here if a specific field ever needs
/// one that's missing) — and a PARENT breadcrumb per line, since a raw
/// indentation level is hard to eyeball-match back to "which container" in
/// a long flat text file.
///
/// PHI: the ONLY per-element content ever captured beyond pure UI
/// STRUCTURE is a Value-pattern read, and even that is TRUNCATED to
/// <see cref="MaxValueChars"/> characters (see TruncateValue) — never a
/// full field value. Dumps are written to local disk only; see the
/// uia-dumps\README.txt this class writes alongside the first dump (never
/// auto-uploaded — Will attaches a dump file to a message himself, the
/// same way he'd attach any other file).
///
/// PATTERN LIST CAVEAT: this dev environment has no working `dotnet`
/// (macOS box, Windows-only WPF/FlaUI target), so this file could not be
/// compiled or run here. The FlaUI.Core 4.0.0 AutomationElement.Patterns.*
/// property names below were cross-checked against the actual installed
/// NuGet package's IL metadata (not guessed from memory) and match the
/// same `element.Patterns.Value`/`.Toggle`/`.SelectionItem`-shaped calls
/// rx-verify's own UiaTreeWalker.cs already uses successfully in
/// production — but Will should sanity-check the FIRST real dump this
/// produces (every row looks plausible, no exceptions logged via "Dump
/// failed" / AppFileLog) before relying on it for field-mapping work.
/// </summary>
public static class UiaTreeDumper
{
    /// <summary>PHI minimization — see class doc. The point of a dump is UI
    /// structure, not field contents.</summary>
    private const int MaxValueChars = 40;

    /// <summary>Safety limits so a pathological/looping tree (or a screen
    /// far larger than anything seen in rx-verify's own dumps) can't hang
    /// the UI thread or produce an unbounded file.</summary>
    private const int MaxDepth = 60;
    private const int MaxNodes = 25_000;

    public readonly record struct DumpOutcome(bool Success, string? FilePath, string Message);

    /// <summary>
    /// Attaches to the current PioneerRx window (PioneerRxAttachment —
    /// same widened title/process match FocusPioneerWindowStep uses) and
    /// dumps its whole UIA tree. Never throws — every failure mode
    /// (nothing found, UIA session error, couldn't write the file) comes
    /// back as DumpOutcome.Success = false with a message to show the
    /// user, same "never crash the popup" convention as the rest of
    /// PioneerEntryAutomation/Uia.
    /// </summary>
    public static DumpOutcome DumpAttachedPioneerWindow()
    {
        AutomationElement? window;
        try
        {
            window = PioneerRxAttachment.TryAttach();
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("UiaTreeDumper.DumpAttachedPioneerWindow.Attach", ex);
            return new DumpOutcome(false, null, $"Couldn't attach to PioneerRx: {ex.Message}");
        }

        if (window is null)
        {
            return new DumpOutcome(false, null,
                "No PioneerRx window found to dump — bring the screen you want to capture to the " +
                "foreground first (see PioneerEntryAutomation/TODO.md's dump-collection instructions), then try again.");
        }

        return DumpWindowToFile(window);
    }

    private static DumpOutcome DumpWindowToFile(AutomationElement window)
    {
        var sb = new StringBuilder();
        var windowTitle = SafeName(window);

        sb.AppendLine("Vaccine Assist -- PioneerRx UIA tree dump");
        sb.AppendLine($"Captured: {DateTime.Now:yyyy-MM-dd HH:mm:ss} local");
        sb.AppendLine($"Window title: \"{windowTitle}\"");
        sb.AppendLine("Each line: ControlType name='...' id='...' class='...' rect=... patterns=[...] value='...' parent=...");
        sb.AppendLine($"(values truncated to {MaxValueChars} chars -- structure is the point of this dump, not full field contents)");
        sb.AppendLine(new string('-', 100));

        var nodeCount = 0;
        var truncated = false;
        WalkRecursive(window, depth: 0, parentDescriptor: "<root>", sb, ref nodeCount, ref truncated);

        if (truncated)
        {
            sb.AppendLine();
            sb.AppendLine($"*** DUMP TRUNCATED -- hit the {MaxNodes}-node or {MaxDepth}-deep safety limit. Everything past that point in the tree was not captured. ***");
        }

        try
        {
            var path = WriteDumpFile(sb.ToString());
            AppFileLog.Log($"[UiaTreeDumper] Wrote dump ({nodeCount} nodes{(truncated ? ", truncated" : "")}) to {path}");
            return new DumpOutcome(true, path, $"Saved UIA dump ({nodeCount} elements) to:\n{path}\n\nPath copied to clipboard.");
        }
        catch (Exception ex)
        {
            AppFileLog.LogException("UiaTreeDumper.DumpWindowToFile.Write", ex);
            return new DumpOutcome(false, null, $"Captured the tree but couldn't save it to disk: {ex.Message}");
        }
    }

    private static void WalkRecursive(
        AutomationElement element, int depth, string parentDescriptor,
        StringBuilder sb, ref int nodeCount, ref bool truncated)
    {
        if (nodeCount >= MaxNodes || depth > MaxDepth)
        {
            truncated = true;
            return;
        }

        nodeCount++;

        var d = DescribeElement(element);
        sb.Append(' ', depth * 2)
          .Append(d.ControlType)
          .Append(" name='").Append(d.Name).Append('\'')
          .Append(" id='").Append(d.AutomationId).Append('\'')
          .Append(" class='").Append(d.ClassName).Append('\'')
          .Append(" rect=").Append(d.Rect)
          .Append(" patterns=[").Append(d.Patterns).Append(']');

        if (d.Value is not null)
        {
            sb.Append(" value='").Append(d.Value).Append('\'');
        }

        sb.Append(" parent=").Append(parentDescriptor);
        sb.AppendLine();

        AutomationElement[] children;
        try
        {
            children = element.FindAllChildren();
        }
        catch
        {
            return; // stale/disconnected element mid-redraw -- this subtree just ends here
        }

        var thisDescriptor = $"{d.ControlType}('{d.Name}')";
        foreach (var child in children)
        {
            WalkRecursive(child, depth + 1, thisDescriptor, sb, ref nodeCount, ref truncated);
            if (nodeCount >= MaxNodes)
            {
                truncated = true;
                break;
            }
        }
    }

    private readonly record struct ElementDescription(
        string ControlType, string Name, string AutomationId, string ClassName, string Rect, string Patterns, string? Value);

    private static ElementDescription DescribeElement(AutomationElement element)
    {
        string controlType = "<threw>";
        string name = "<threw>";
        string automationId = "<threw>";
        string className = "<threw>";
        string rect = "<threw>";

        try { controlType = element.ControlType.ToString(); } catch { /* best-effort dump, see class doc */ }
        try { name = element.Name ?? "<null>"; } catch { }
        try { automationId = element.AutomationId ?? "<null>"; } catch { }
        try { className = element.ClassName ?? "<null>"; } catch { }
        try { rect = element.BoundingRectangle.ToString(); } catch { }

        return new ElementDescription(controlType, name, automationId, className, rect,
            DescribeSupportedPatterns(element), TryReadTruncatedValue(element));
    }

    /// <summary>
    /// Checked individually (not via reflection/an enumerate-everything
    /// API) — see class doc's PATTERN LIST CAVEAT. Covers the patterns
    /// most relevant to filling in a form; add more `Check(...)` calls
    /// here if a specific field turns out to need one that's missing
    /// (FlaUI.Core.AutomationElements.PatternElements also exposes Drag,
    /// SynchronizedInput, Annotation, Styles, Spreadsheet(Item), TextEdit,
    /// TextChild, ObjectModel, Transform, MultipleView, VirtualizedItem,
    /// ItemContainer, LegacyIAccessible, DropTarget, Selection2,
    /// Transform2, Text2).
    /// </summary>
    private static string DescribeSupportedPatterns(AutomationElement element)
    {
        var supported = new List<string>();

        void Check(string label, Func<AutomationElement, bool> isSupported)
        {
            try
            {
                if (isSupported(element)) supported.Add(label);
            }
            catch
            {
                // Pattern advertised as available but the provider threw
                // anyway -- seen in practice with some WinForms UIA
                // proxies (same caveat rx-verify's UiaTreeWalker.cs
                // documents for ReadEditOrComboValue). Just omit it.
            }
        }

        Check("Invoke", e => e.Patterns.Invoke.IsSupported);
        Check("Value", e => e.Patterns.Value.IsSupported);
        Check("Toggle", e => e.Patterns.Toggle.IsSupported);
        Check("SelectionItem", e => e.Patterns.SelectionItem.IsSupported);
        Check("Selection", e => e.Patterns.Selection.IsSupported);
        Check("ExpandCollapse", e => e.Patterns.ExpandCollapse.IsSupported);
        Check("RangeValue", e => e.Patterns.RangeValue.IsSupported);
        Check("Scroll", e => e.Patterns.Scroll.IsSupported);
        Check("ScrollItem", e => e.Patterns.ScrollItem.IsSupported);
        Check("Grid", e => e.Patterns.Grid.IsSupported);
        Check("GridItem", e => e.Patterns.GridItem.IsSupported);
        Check("Table", e => e.Patterns.Table.IsSupported);
        Check("TableItem", e => e.Patterns.TableItem.IsSupported);
        Check("Window", e => e.Patterns.Window.IsSupported);
        Check("Dock", e => e.Patterns.Dock.IsSupported);
        Check("Text", e => e.Patterns.Text.IsSupported);

        return supported.Count == 0 ? "none" : string.Join(",", supported);
    }

    private static string? TryReadTruncatedValue(AutomationElement element)
    {
        try
        {
            if (!element.Patterns.Value.IsSupported) return null;
            var value = element.Patterns.Value.Pattern.Value.ValueOrDefault;
            return string.IsNullOrEmpty(value) ? null : TruncateValue(value);
        }
        catch
        {
            return null;
        }
    }

    /// <summary>Extracted as its own pure, no-UIA-dependency method so it's
    /// unit-testable (see VaccineAssist.Desktop.Tests\UiaTreeDumperTruncationTests.cs
    /// — public rather than internal since this repo has no
    /// InternalsVisibleTo wired up, matching Uia/PioneerRxPresenceDecision.cs's
    /// same "pure logic split out as a public static method" pattern) even
    /// though the rest of this class needs a live UIA session.</summary>
    public static string TruncateValue(string value) =>
        value.Length <= MaxValueChars ? value : value[..MaxValueChars] + "...(truncated)";

    private static string SafeName(AutomationElement element)
    {
        try { return element.Name ?? ""; }
        catch { return ""; }
    }

    private static string WriteDumpFile(string contents)
    {
        var dir = DumpDirectory;
        Directory.CreateDirectory(dir);
        EnsureReadme(dir);

        var fileName = $"dump-{DateTime.Now:yyyyMMdd-HHmmss}.txt";
        var path = Path.Combine(dir, fileName);
        File.WriteAllText(path, contents, Encoding.UTF8);
        return path;
    }

    private static string DumpDirectory => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "VaccineAssist", "uia-dumps");

    private static void EnsureReadme(string dir)
    {
        var readmePath = Path.Combine(dir, "README.txt");
        if (File.Exists(readmePath)) return;

        File.WriteAllText(readmePath,
            "Vaccine Assist -- PioneerRx UIA tree dumps\r\n" +
            "===========================================\r\n\r\n" +
            "Each dump-YYYYMMDD-HHMMSS.txt file here is a full snapshot of the PioneerRx\r\n" +
            "window's accessibility (UIA) tree, captured by the app's \"Dump Pioneer UIA\r\n" +
            "tree\" button (Data entry tab, and the Ctrl+NumPad2 popup) -- see\r\n" +
            "PioneerEntryAutomation\\TODO.md for why this is needed: wiring the real\r\n" +
            "vaccine-entry automation against confirmed field targets instead of guesses.\r\n\r\n" +
            "PHI NOTE: field VALUES are captured (truncated to 40 characters) alongside\r\n" +
            "the UI structure, so a dump taken with a real patient's screen open could\r\n" +
            "incidentally contain on-screen values. These files are NEVER uploaded or\r\n" +
            "sent anywhere automatically by this app -- attach one to a message yourself\r\n" +
            "when you're ready to send it, the same way you'd attach any other file.\r\n",
            Encoding.UTF8);
    }
}
