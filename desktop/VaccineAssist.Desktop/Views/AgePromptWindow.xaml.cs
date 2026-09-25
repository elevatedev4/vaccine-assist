using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;

namespace VaccineAssist.Desktop.Views;

/// <summary>
/// Ctrl+Keypad 4 (Will, 2026-09-25) — see AgePromptWindow.xaml's doc
/// comment for the full brief/shell rationale. Same "static
/// ShowAndGetResult, modal ShowDialog, Result property" convention as
/// TextEntryPromptWindow/VarUpdateConfirmationWindow.
/// </summary>
public partial class AgePromptWindow : Window
{
    public AgePromptWindow()
    {
        InitializeComponent();
    }

    public AgePromptResult Result { get; private set; } = AgePromptResult.Cancelled;

    private void AgePromptWindow_OnLoaded(object sender, RoutedEventArgs e)
    {
        YearsTextBox.Focus();
        Keyboard.Focus(YearsTextBox);
    }

    /// <summary>Digits only — same "don't let the user type something
    /// that can't be a valid age" posture as the OK button's
    /// AgePromptInput-gated enabled state below.</summary>
    private void AgeTextBox_OnPreviewTextInput(object sender, TextCompositionEventArgs e)
    {
        e.Handled = !e.Text.All(char.IsDigit);
    }

    private void AgeTextBox_OnTextChanged(object sender, TextChangedEventArgs e)
    {
        OkButton.IsEnabled = AgePromptInput.TryParse(YearsTextBox.Text, MonthsTextBox.Text, out _, out _);
    }

    /// <summary>Enter in either textbox is the fast path to OK — same
    /// convention as DataEntryPopupWindow's AgeTextBox_OnKeyDown/
    /// TextEntryPromptWindow's ValueTextBox_OnKeyDown.</summary>
    private void AgeTextBox_OnKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter)
        {
            TryContinue();
        }
    }

    private void OkButton_OnClick(object sender, RoutedEventArgs e) => TryContinue();

    /// <summary>Refuses to return Continued with an age AgePromptInput
    /// doesn't accept — the OK button is disabled in that state already
    /// (see AgeTextBox_OnTextChanged), but Enter can still reach here, so
    /// this re-checks rather than trusting the button's enabled state.</summary>
    private void TryContinue()
    {
        if (!AgePromptInput.TryParse(YearsTextBox.Text, MonthsTextBox.Text, out var years, out var months))
        {
            return;
        }

        Result = AgePromptResult.Continued(years, months);
        DialogResult = true;
    }

    private void CancelButton_OnClick(object sender, RoutedEventArgs e)
    {
        Result = AgePromptResult.Cancelled;
        DialogResult = false;
    }

    /// <summary>Same "the window's own Escape just closes/cancels" rule
    /// as MacroCodesWindow_OnPreviewKeyDown.</summary>
    private void AgePromptWindow_OnPreviewKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Escape)
        {
            Result = AgePromptResult.Cancelled;
            DialogResult = false;
        }
    }

    /// <summary>Shows the dialog modally (no Owner — see the xaml's doc
    /// comment) and returns the outcome.</summary>
    public static AgePromptResult ShowAndGetResult()
    {
        var window = new AgePromptWindow();
        window.ShowDialog();
        return window.Result;
    }
}
