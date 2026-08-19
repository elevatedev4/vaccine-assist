namespace VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing;

/// <summary>Shared message text for every placeholder step's not-yet-wired failure — see PlaceholderVaccineEntrySequence and PioneerEntryAutomation/TODO.md.</summary>
public static class PendingMacroFile
{
    public const string Message =
        "PENDING-MACRO-FILE: field targets aren't wired yet — see PioneerEntryAutomation/TODO.md. " +
        "Attach vaccine-add-new.mxe (or a live PioneerRx UIA tree dump of the vaccine entry screen) to finish this step.";
}
