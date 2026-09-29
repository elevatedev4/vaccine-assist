namespace VaccineAssist.Desktop.ViewModels;

/// <summary>
/// FaxSendWindow's state machine (V-T65 R4, Will verbatim, 2026-09-29:
/// "have it be ... a dialogue window where you can select the file then
/// push send then see the results below"). Pure enum so
/// FaxSendViewModel's transitions are directly unit-testable without any
/// WPF/Window involvement.
///
///   NoFile      -> no report picked yet; Send is disabled, results empty.
///   FileChosen  -> a file is picked (or a previous run finished/failed
///                  and Will can pick a new one or re-send); Send enabled.
///   Sending     -> RunAsync is in flight; Send/Choose file both disabled
///                  so a second click can't start a concurrent run or
///                  swap the file mid-send.
///   Done        -> RunAsync returned a summary; results grid + totals
///                  are populated. Choosing a new file goes back to
///                  FileChosen (see FaxSendViewModel.SetChosenFile).
/// </summary>
public enum FaxSendState
{
    NoFile,
    FileChosen,
    Sending,
    Done,
}
