namespace VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing;

/// <summary>One step's outcome — always produced (never throws out of the runner), see PioneerEntrySequenceRunner.</summary>
public sealed record PioneerEntryStepResult(string StepName, bool Success, bool DryRun, string Message);
