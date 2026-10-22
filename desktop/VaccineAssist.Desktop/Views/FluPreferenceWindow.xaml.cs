using System;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Input;
using System.Windows.Interop;
using VaccineAssist.Desktop.FluPreference;
using VaccineAssist.Desktop.Logging;

namespace VaccineAssist.Desktop.Views;

/// <summary>What the pharmacist chose in FluPreferenceWindow. Cancel also covers the X button and Esc.</summary>
public enum FluPreferenceChoice
{
    Cancel,
    ProceedPreferred,
    ProceedSelected,
}

/// <summary>
/// Shown after a flu product is picked that is NOT the preferred one for the
/// patient's age (see FluPreferenceRules). Says what was selected, the age,
/// and the preferred product (plus the approval note when the selected
/// product is outside its approved ages). Two buttons - "Proceed with
/// &lt;preferred&gt;" (highlighted default) and "Proceed with &lt;selected&gt;".
/// Contains no patient identifiers: only an age in years and product names.
/// </summary>
public partial class FluPreferenceWindow : Window
{
    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    public FluPreferenceChoice Choice { get; private set; } = FluPreferenceChoice.Cancel;

    private readonly FluPreferencePrompt _prompt;
    private bool _closed;

    /// <summary>
    /// Shows at once (Will, 2026-10-22: the popup "should really be instant").
    /// <paramref name="preferredLookup"/> (product + current lot) usually has
    /// finished already; when it has not, the preferred button stays disabled
    /// ("checking stock") until it does, then enables - or, when the preferred
    /// product can't be entered, collapses with the reason shown. No lookup
    /// result is needed to show the selected/preferred names or the age.
    /// </summary>
    public FluPreferenceWindow(FluPreferencePrompt prompt, Task<PreferredFluResult> preferredLookup)
    {
        InitializeComponent();
        _prompt = prompt;

        SelectedTextBlock.Text = $"You selected {prompt.SelectedName}.";
        AgeTextBlock.Text = $"Patient age: {prompt.AgeYears}.";
        PreferredTextBlock.Text = $"The preferred flu vaccine for ages {prompt.PreferredBandText} is {prompt.PreferredName}.";

        if (!string.IsNullOrWhiteSpace(prompt.ApprovedNote))
        {
            ApprovedNoteTextBlock.Text = prompt.ApprovedNote;
            ApprovedNoteTextBlock.Visibility = Visibility.Visible;
        }

        SelectedButton.Content = $"Proceed with {prompt.SelectedName}";
        PreferredButton.Content = $"Proceed with {prompt.PreferredName}";
        Closed += (_, _) => _closed = true;

        if (prompt.RangeWarningOnly)
        {
            // FluMist outside its approved ages: a warning only, no preferred product.
            Title = "Age range";
            PreferredTextBlock.Visibility = Visibility.Collapsed;
            PreferredButton.Visibility = Visibility.Collapsed;
            PreferredButton.IsDefault = false;
            CancelButton.Visibility = Visibility.Visible;
            SelectedButton.IsDefault = true;
            return;
        }

        // The preferred choice depends on the age alone, so it is clickable and the
        // default (Enter) the moment the window shows. Stock/lot is checked in the
        // background and only adds a note; it never disables a button.
        PreferredButton.IsEnabled = true;
        PreferredButton.IsDefault = true;

        if (preferredLookup.IsCompletedSuccessfully)
        {
            ShowStockNote(preferredLookup.Result);
            return;
        }

        _ = AwaitLookupAsync(preferredLookup);
    }

    private async Task AwaitLookupAsync(Task<PreferredFluResult> preferredLookup)
    {
        PreferredFluResult result;
        try
        {
            result = await preferredLookup;
        }
        catch (Exception)
        {
            result = PreferredFluResult.Unavailable($"{_prompt.PreferredName} could not be looked up right now.");
        }

        if (_closed)
        {
            return;
        }

        ShowStockNote(result);
    }

    /// <summary>Inline note only (the button stays selectable): if the preferred product has no usable stock/lot, say so on the button and below it.</summary>
    private void ShowStockNote(PreferredFluResult result)
    {
        if (result.IsAvailable)
        {
            return;
        }

        PreferredButton.Content = $"Proceed with {_prompt.PreferredName} (not in stock)";
        UnavailableTextBlock.Text = string.IsNullOrWhiteSpace(result.UnavailableReason)
            ? $"{_prompt.PreferredName} can't be entered right now."
            : result.UnavailableReason;
        UnavailableTextBlock.Visibility = Visibility.Visible;
    }

    private void FluPreferenceWindow_OnLoaded(object sender, RoutedEventArgs e)
    {
        Activate();
        try
        {
            var handle = new WindowInteropHelper(this).Handle;
            if (handle != IntPtr.Zero)
            {
                TryAttachedSetForeground(handle);
            }
        }
        catch
        {
            // Best-effort - Topmost already keeps the dialog visible.
        }

        Topmost = false;
        Topmost = true;
        FlowTiming.Mark("flu popup shown");

        (PreferredButton.Visibility == Visibility.Visible ? PreferredButton : SelectedButton).Focus();
    }

    /// <summary>Same attach-thread-input foreground recipe as AgePromptWindow.TryAttachedSetForeground.</summary>
    private static void TryAttachedSetForeground(IntPtr handle)
    {
        var foreground = GetForegroundWindow();
        if (foreground == handle) return;

        var foregroundThreadId = foreground == IntPtr.Zero ? 0u : GetWindowThreadProcessId(foreground, out _);
        var currentThreadId = GetCurrentThreadId();
        var attached = false;
        try
        {
            if (foregroundThreadId != 0 && foregroundThreadId != currentThreadId)
            {
                attached = AttachThreadInput(currentThreadId, foregroundThreadId, true);
            }
            BringWindowToTop(handle);
            SetForegroundWindow(handle);
        }
        finally
        {
            if (attached)
            {
                AttachThreadInput(currentThreadId, foregroundThreadId, false);
            }
        }
    }

    private void FluPreferenceWindow_OnPreviewKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Escape)
        {
            e.Handled = true;
            Choice = FluPreferenceChoice.Cancel;
            Close();
        }
    }

    private void PreferredButton_OnClick(object sender, RoutedEventArgs e)
    {
        Choice = FluPreferenceChoice.ProceedPreferred;
        Close();
    }

    private void SelectedButton_OnClick(object sender, RoutedEventArgs e)
    {
        Choice = FluPreferenceChoice.ProceedSelected;
        Close();
    }

    private void CancelButton_OnClick(object sender, RoutedEventArgs e)
    {
        Choice = FluPreferenceChoice.Cancel;
        Close();
    }
}
