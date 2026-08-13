namespace VaccineAssist.Desktop.Models;

/// <summary>
/// The old macro validated this as exactly "l" or "r" and expanded it to
/// "left arm"/"right arm" for the PioneerRx signature field — see
/// vaccine-add-new.mxe lines 49-66. Kept as the same two options.
/// </summary>
public enum AdminSite
{
    LeftArm,
    RightArm,
}

public static class AdminSiteExtensions
{
    /// <summary>The single-letter macro code ("l"/"r").</summary>
    public static string ToMacroCode(this AdminSite site) => site == AdminSite.LeftArm ? "l" : "r";

    public static string ToDisplayText(this AdminSite site) => site == AdminSite.LeftArm ? "Left arm" : "Right arm";
}
