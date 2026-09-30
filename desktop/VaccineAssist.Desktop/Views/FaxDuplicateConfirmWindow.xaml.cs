using System.Collections.Generic;
using System.Linq;
using System.Windows;
using VaccineAssist.Desktop.Fax;

namespace VaccineAssist.Desktop.Views;

/// <summary>
/// V-T65 R6 (Will, verbatim, 2026-09-29): "show an alert, allowing them to
/// continue and potentially send duplicates, cancel altogether, or only
/// send non-duplicates." FaxSendCoordinator.ConfirmDuplicates (wired in
/// MainWindow.xaml.cs) constructs and ShowDialog()s this, then reads
/// Choice back — null means Will closed/cancelled without picking either
/// send option.
/// </summary>
public partial class FaxDuplicateConfirmWindow : Window
{
    public FaxDuplicateChoice? Choice { get; private set; }

    public IReadOnlyList<string> DuplicateLines { get; }

    public FaxDuplicateConfirmWindow(IReadOnlyList<FaxDuplicateMatch> duplicates)
    {
        InitializeComponent();

        DuplicateLines = duplicates
            .Select(d => $"{FormatDate(d.AdministeredDate)} — {d.VaccineName} — " +
                $"{d.PreviouslySentCount} row{(d.PreviouslySentCount == 1 ? "" : "s")} already sent on {d.PreviouslySentRunAtUtc.ToLocalTime():MM/dd/yyyy}")
            .ToList();

        DataContext = this;
    }

    private static string FormatDate(string administeredDateYyyyMmDd) =>
        DateOnly.TryParse(administeredDateYyyyMmDd, out var date) ? date.ToString("MM/dd/yyyy") : administeredDateYyyyMmDd;

    private void SendAllButton_OnClick(object sender, RoutedEventArgs e)
    {
        Choice = FaxDuplicateChoice.SendAll;
        Close();
    }

    private void SendOnlyNewButton_OnClick(object sender, RoutedEventArgs e)
    {
        Choice = FaxDuplicateChoice.SendOnlyNew;
        Close();
    }

    private void CancelButton_OnClick(object sender, RoutedEventArgs e)
    {
        Choice = null;
        Close();
    }
}
