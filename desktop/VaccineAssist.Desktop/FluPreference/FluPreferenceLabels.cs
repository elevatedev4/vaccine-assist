namespace VaccineAssist.Desktop.FluPreference;

/// <summary>
/// Button wording for FluPreferenceWindow (Will, 2026-10-30, verbatim: "Change
/// the wording to "Switch" instead of "Proceed" if you're making a
/// recommendation to switch to the correct vaccine."). Pure - no WPF.
/// </summary>
public static class FluPreferenceLabels
{
    /// <summary>"Switch to X" when the button applies a recommended product different from the one picked; otherwise "Proceed with X".</summary>
    public static string ConfirmButtonText(bool recommendsSwitch, string productName) =>
        recommendsSwitch ? $"Switch to {productName}" : $"Proceed with {productName}";
}
