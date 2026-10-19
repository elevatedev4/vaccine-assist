using System;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Input;
using System.Windows.Interop;
using VaccineAssist.Desktop.FluPreference;

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

    /// <param name="preferredAvailable">False when the preferred product can't be entered; then only "Proceed with &lt;selected&gt;" and Cancel are offered.</param>
    /// <param name="unavailableReason">Shown when preferredAvailable is false.</param>
    public FluPreferenceWindow(FluPreferencePrompt prompt, bool preferredAvailable, string? unavailableReason)
    {
        InitializeComponent();

        SelectedTextBlock.Text = $"You selected {prompt.SelectedName}.";
        AgeTextBlock.Text = $"Patient age: {prompt.AgeYears}.";
        PreferredTextBlock.Text = $"The preferred flu vaccine for ages {prompt.PreferredBandText} is {prompt.PreferredName}.";

        if (!string.IsNullOrWhiteSpace(prompt.ApprovedNote))
        {
            ApprovedNoteTextBlock.Text = prompt.ApprovedNote;
            ApprovedNoteTextBlock.Visibility = Visibility.Visible;
        }

        SelectedButton.Content = $"Proceed with {prompt.SelectedName}";
        if (preferredAvailable)
        {
            PreferredButton.Content = $"Proceed with {prompt.PreferredName}";
        }
        else
        {
            PreferredButton.Visibility = Visibility.Collapsed;
            PreferredButton.IsDefault = false;
            CancelButton.Visibility = Visibility.Visible;
            UnavailableTextBlock.Text = string.IsNullOrWhiteSpace(unavailableReason)
                ? $"{prompt.PreferredName} can't be entered right now."
                : unavailableReason;
            UnavailableTextBlock.Visibility = Visibility.Visible;
            SelectedButton.IsDefault = true;
        }
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
