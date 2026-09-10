using System.Windows;
using System.Windows.Input;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing;

namespace VaccineAssist.Desktop.Views;

/// <summary>
/// V-..., 2026-09-10: the blank-Quantity/blank-Directions prompt
/// InputQuantityStep/InputDirectionsStep show instead of silently skipping
/// (Will, 2026-09-09/10: entry "made it through to quantity (slowly) and
/// stopped at quantity (not entered)" — every vaccine row currently has a
/// null quantity/blank directions on file, so the old silent-skip WAS the
/// "stopped" behavior he saw). Same popup-focus mechanics as
/// VarUpdateConfirmationWindow: owned by the data-entry popup window,
/// ShowDialog (modal, so it comes to the front over PioneerRx without
/// needing its own SetForegroundWindow dance — DataEntryPopupWindow is
/// already the foreground/Topmost window by the time "Enter into Pioneer"
/// runs this sequence).
/// </summary>
public partial class TextEntryPromptWindow : Window
{
    public TextEntryPromptWindow(string title, string message, bool allowSkip, Window owner)
    {
        InitializeComponent();
        Owner = owner;
        Title = title;
        MessageTextBlock.Text = message;
        SkipButton.Visibility = allowSkip ? Visibility.Visible : Visibility.Collapsed;
    }

    public TextPromptResult Result { get; private set; } = TextPromptResult.Cancelled;

    private void TextEntryPromptWindow_OnLoaded(object sender, RoutedEventArgs e)
    {
        ValueTextBox.Focus();
        Keyboard.Focus(ValueTextBox);
    }

    private void ValueTextBox_OnKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter)
        {
            TryContinue();
        }
    }

    private void ContinueButton_OnClick(object sender, RoutedEventArgs e) => TryContinue();

    /// <summary>Refuses to return Continue with a blank textbox — nothing
    /// to type into Pioneer, so this just leaves the prompt open rather
    /// than handing a step an empty "provided" value it would have to
    /// re-validate itself.</summary>
    private void TryContinue()
    {
        var value = ValueTextBox.Text.Trim();
        if (value.Length == 0) return;

        Result = TextPromptResult.Continued(value);
        DialogResult = true;
    }

    private void SkipButton_OnClick(object sender, RoutedEventArgs e)
    {
        Result = TextPromptResult.Skipped;
        DialogResult = true;
    }

    private void CancelButton_OnClick(object sender, RoutedEventArgs e)
    {
        Result = TextPromptResult.Cancelled;
        DialogResult = false;
    }

    /// <summary>Shows the dialog modally (owned by `owner`) and returns
    /// the outcome — the shape DataEntryPopupViewModel.RequestTextPromptRequested
    /// (a plain Func) needs. allowSkip shows/hides the Skip button
    /// (InputDirectionsStep only — see PioneerEntryStepContext.RequestTextPrompt's
    /// own doc comment).</summary>
    public static TextPromptResult ShowAndGetResult(string title, string message, bool allowSkip, Window owner)
    {
        var window = new TextEntryPromptWindow(title, message, allowSkip, owner);
        window.ShowDialog();
        return window.Result;
    }
}
