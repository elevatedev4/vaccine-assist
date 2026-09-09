using System.Windows;

namespace VaccineAssist.Desktop.Views;

/// <summary>
/// V-T21 item 6 (Will, 2026-09-08, verbatim): "The pharmacist update VAR
/// prompt needs to be a popup not just a little text prompt. The popup
/// should have a checkbox saying that they have asked the pharmacist to
/// update the VAR then click ok to continue." Replaces the old inline
/// red/orange text-only prompt for this specific case — see
/// ViewModels/DataEntryPopupViewModel.cs's RequiresVarUpdateConfirmation
/// (true only for the expired/past-beyond-use-date "was fine, now isn't"
/// cases, never "no lot on file at all") and ConfirmVarUpdateRequested
/// (the delegate DataEntryPopupWindow wires to ShowAndGetConfirmation
/// below).
/// </summary>
public partial class VarUpdateConfirmationWindow : Window
{
    public VarUpdateConfirmationWindow(string message, Window owner)
    {
        InitializeComponent();
        Owner = owner;
        MessageTextBlock.Text = message;
    }

    /// <summary>True only when the user checked the acknowledgment box
    /// AND clicked OK — never true from Cancel, Esc, or closing the
    /// window any other way.</summary>
    public bool Confirmed { get; private set; }

    private void ConfirmedCheckBox_OnCheckedChanged(object sender, RoutedEventArgs e)
    {
        OkButton.IsEnabled = ConfirmedCheckBox.IsChecked == true;
    }

    private void OkButton_OnClick(object sender, RoutedEventArgs e)
    {
        Confirmed = ConfirmedCheckBox.IsChecked == true;
        DialogResult = true;
    }

    private void CancelButton_OnClick(object sender, RoutedEventArgs e)
    {
        Confirmed = false;
        DialogResult = false;
    }

    /// <summary>Shows the dialog modally (owned by `owner` so it stays on
    /// top of/centered over the data-entry popup) and returns whether it
    /// was confirmed — the shape DataEntryPopupViewModel.ConfirmVarUpdateRequested
    /// (a plain Func&lt;string, bool&gt;) needs.</summary>
    public static bool ShowAndGetConfirmation(string message, Window owner)
    {
        var window = new VarUpdateConfirmationWindow(message, owner);
        window.ShowDialog();
        return window.Confirmed;
    }
}
