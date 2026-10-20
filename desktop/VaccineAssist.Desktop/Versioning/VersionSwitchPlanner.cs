using System;

namespace VaccineAssist.Desktop.Versioning;

public enum VersionSwitchOutcome
{
    /// <summary>Safe to ask for confirmation and relaunch.</summary>
    Proceed,
    AlreadyRunning,
    InvalidRef,
    EntryBusy,
    CheckoutNotFound,
}

/// <summary>What to do with a Version-menu click. Every outcome except Proceed carries a plain-words Message that MUST be shown to the user (no silent path).</summary>
public sealed record VersionSwitchPlan(VersionSwitchOutcome Outcome, string? Message);

/// <summary>
/// The pure decision half of MainWindow.SwitchVersion: given the running
/// build, the requested ref, the resolved install folder and whether a
/// vaccine entry is running, say whether to go ahead or why not. Kept
/// WPF-free so the "every refusal explains itself" rule is unit-testable.
/// </summary>
public static class VersionSwitchPlanner
{
    public const string EntryBusyMessage =
        "A vaccine entry is in progress. Finish or cancel it before switching versions.";

    public const string CheckoutNotFoundMessage =
        "Could not find the Vaccine Assist install folder, so the version cannot be switched. Nothing was changed.";

    public static VersionSwitchPlan Evaluate(BuildInfo current, string? requestedRef, string? primaryRoot, bool entryBusy)
    {
        if (!TestingBranchParser.IsLaunchableRef(requestedRef))
        {
            return new VersionSwitchPlan(
                VersionSwitchOutcome.InvalidRef,
                $"\"{requestedRef}\" is not a version Vaccine Assist can switch to. Nothing was changed.");
        }

        var currentRef = current.IsTesting ? current.Ref : BuildInfo.StableRef;
        if (string.Equals(requestedRef, currentRef, StringComparison.Ordinal))
        {
            return new VersionSwitchPlan(
                VersionSwitchOutcome.AlreadyRunning,
                $"You are already running {VersionMenuBuilder.DisplayName(currentRef)}. Nothing was changed.");
        }

        if (entryBusy)
        {
            return new VersionSwitchPlan(VersionSwitchOutcome.EntryBusy, EntryBusyMessage);
        }

        if (string.IsNullOrWhiteSpace(primaryRoot))
        {
            return new VersionSwitchPlan(VersionSwitchOutcome.CheckoutNotFound, CheckoutNotFoundMessage);
        }

        return new VersionSwitchPlan(VersionSwitchOutcome.Proceed, null);
    }
}
