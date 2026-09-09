using System;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;
using VaccineAssist.Desktop.Logging;
using VaccineAssist.Desktop.Models;
using VaccineAssist.Desktop.ViewModels;

namespace VaccineAssist.Desktop.Views;

/// <summary>
/// The Ctrl+NumPad7 popup (V-T3). Non-modal (Show, not ShowDialog) so the
/// pharmacist can still click back into PioneerRx while this stays
/// Topmost — matches the "quick popup while working the Rx profile"
/// workflow described in the brief. A fresh DataEntryPopupViewModel is
/// created per popup instance (see MainWindow.xaml.cs) and discarded on
/// Closed, so PatientAgeYears never outlives one popup session.
/// </summary>
public partial class DataEntryPopupWindow : Window
{
    /// <summary>MSG893 item 2: see ActivateAndFocusCurrentStage's doc
    /// comment for why this P/Invoke is needed on top of
    /// Activate()/Focus(). MSG893 item 1 rework (2026-09-08) added the
    /// P/Invokes below it for the fuller foreground-stealing sequence —
    /// see that method's doc comment for the full rationale/ordering.</summary>
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, [MarshalAs(UnmanagedType.Bool)] bool fAttach);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern IntPtr SetActiveWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AllowSetForegroundWindow(uint dwProcessId);

    [DllImport("user32.dll")]
    private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    /// <summary>ASFW_ANY — see Win32 AllowSetForegroundWindow docs (passing this instead of a specific PID allows the NEXT SetForegroundWindow call from ANY process through).</summary>
    private const uint ASFW_ANY = 0xFFFFFFFF;

    /// <summary>VK_MENU (Alt) — see the "Alt nudge" fallback in ActivateAndFocusCurrentStage's doc comment.</summary>
    private const byte VK_MENU = 0x12;

    private const uint KEYEVENTF_KEYUP = 0x0002;

    private readonly DataEntryPopupViewModel _viewModel;

    public DataEntryPopupWindow(DataEntryPopupViewModel viewModel)
    {
        InitializeComponent();
        _viewModel = viewModel;
        DataContext = _viewModel;

        // V-T21 item 6: wires the ViewModel's VAR-update confirmation gate
        // to the actual modal dialog — see
        // DataEntryPopupViewModel.ConfirmVarUpdateRequested's own doc
        // comment for why this MUST be set here (the gate fails closed
        // when it's null).
        _viewModel.ConfirmVarUpdateRequested = message => VarUpdateConfirmationWindow.ShowAndGetConfirmation(message, this);
    }

    /// <summary>
    /// GUIDED FLOW rework (V-... Part B): the popup no longer preloads a
    /// flat vaccine list (there's nothing to load until an age is entered
    /// — see DataEntryPopupViewModel.ContinueFromAgeAsync), so this just
    /// activates/focuses the current stage's control on first show — "keep
    /// it a fast textbox, autofocused" per the brief — instead of the old
    /// LoadAsync() call. See ActivateAndFocusCurrentStage for the actual
    /// focus/activation work (MSG893 item 2 made this robust against the
    /// popup opening while PioneerRx is the foreground window).
    /// </summary>
    private void DataEntryPopupWindow_OnLoaded(object sender, RoutedEventArgs e)
    {
        ActivateAndFocusCurrentStage();
    }

    /// <summary>
    /// MSG893 item 2 ("Popup must take and keep focus, cursor in the age
    /// box"): brings this popup to the foreground and puts keyboard focus
    /// on the CURRENT stage's primary control. Called from Loaded on first
    /// show (always the Age stage), AND by MainWindow.ShowDataEntryPopup
    /// when the hotkey (or the "Open data entry popup" button) is pressed
    /// again while this popup is ALREADY open — possibly mid-flow, at any
    /// stage — that re-activates/re-focuses the existing popup instead of
    /// opening a duplicate.
    ///
    /// REVIEWER FIX (Moderate, request-changes round): this used to be
    /// ActivateAndFocusAge and unconditionally called AgeTextBox.Focus() —
    /// but AgeTextBox is Collapsed at every stage except IsAgeStage (see
    /// DataEntryPopupWindow.xaml), and WPF silently no-ops a Focus() call
    /// on a collapsed control. A repeat hotkey press mid-flow (Group/
    /// Product/Dose/Review) brought the window forward but landed keyboard
    /// focus nowhere at all. Renamed and reworked to focus whichever
    /// stage's own primary visible control actually is: AgeTextBox on Age,
    /// the first RadioButton in that stage's ItemsControl on Group/
    /// Product/Dose (those lists have no single named control — each
    /// RadioButton is generated per-item by a DataTemplate, see the
    /// Checked-handler doc comment below), and the "Enter into Pioneer"
    /// button on Review.
    ///
    /// Plain Show() + Topmost="True" + Activate()/Focus() is not reliable
    /// here: this popup is launched from a GLOBAL hotkey while PioneerRx
    /// is the foreground window, and Windows' foreground-lock timeout
    /// normally refuses to let a background process steal keyboard focus
    /// from whatever the user is actively using. The popup can end up
    /// visually on top (Topmost) but WITHOUT keyboard focus, so typed
    /// input keeps going to PioneerRx instead — the exact "doesn't get
    /// keyboard focus" symptom reported. The fix is the standard one: call
    /// Activate() first (WPF's own focus/activation request), then
    /// P/Invoke SetForegroundWindow directly on this window's handle.
    /// SetForegroundWindow is itself normally subject to that same
    /// foreground-lock restriction UNLESS the calling thread currently
    /// holds foreground-activation rights — which Win32 GRANTS to
    /// whichever thread is processing a registered hotkey's WM_HOTKEY
    /// message (see Hotkeys/GlobalHotKey.cs's WndProc/Pressed event).
    /// MainWindow's GlobalHotKey.Pressed handler calls ShowDataEntryPopup()
    /// -&gt; this method SYNCHRONOUSLY on that same dispatcher callback, so
    /// the call below runs while those rights are still held for a
    /// fresh popup — legitimate, not a workaround. When the popup is
    /// instead opened/re-focused via a mouse click
    /// (EntryViewModel.OpenPopupCommand), the click itself already carries
    /// normal foreground rights, so this call is harmless there too.
    /// </summary>
    /// <summary>
    /// MSG893 item 1 rework (Will, 2026-09-08, verbatim): "When I start
    /// data entry, I still have to click into Patient Age to get it to
    /// work right. The screen isn't focusing on the app... I think it's
    /// staying on Pioneer." The previous Activate()+SetForegroundWindow
    /// sequence documented above wasn't reliable enough in practice — this
    /// replaces it with the fuller, multi-fallback sequence Will asked
    /// for, run in order every time:
    ///   1. Show() if the window isn't currently Visible (and un-minimize
    ///      it) — belt-and-suspenders; nothing in this app calls Hide()
    ///      or minimizes this popup today, but a hotkey-triggered
    ///      re-activation should never no-op just because some future
    ///      change does.
    ///   2. AllowSetForegroundWindow(ASFW_ANY) — tells Windows the NEXT
    ///      SetForegroundWindow call from ANY process is allowed through,
    ///      bypassing the foreground-lock timeout a call from a
    ///      not-currently-foreground process would otherwise hit.
    ///   3. TryAttachedSetForeground: if the CURRENT foreground window
    ///      (expected: PioneerRx) belongs to a different UI thread,
    ///      AttachThreadInput borrows its input state so
    ///      BringWindowToTop/SetForegroundWindow/SetActiveWindow on this
    ///      window actually take — then detaches again immediately (an
    ///      attach left in place merges the two threads' input queues,
    ///      which must never be left standing).
    ///   4. If GetForegroundWindow() still isn't this window afterward,
    ///      an "Alt nudge" (synthetic VK_MENU down+up — Windows exempts
    ///      whichever process most recently processed an Alt keypress
    ///      from the foreground-lock timeout, a well-known
    ///      SetForegroundWindow workaround) then retries
    ///      SetForegroundWindow/SetActiveWindow.
    ///   5. Toggle Topmost false-&gt;true — forces WPF to reassert this
    ///      window's z-order/activation state, which can clear a
    ///      "visually on top but not actually the active window" state
    ///      that SetForegroundWindow alone left behind.
    ///   6. Keyboard focus onto the current stage's primary control is
    ///      scheduled (ScheduleFocusCurrentStagePrimaryControl —
    ///      Dispatcher.BeginInvoke at DispatcherPriority.Input) rather
    ///      than placed synchronously here: WPF can't reliably accept a
    ///      focus request before the window has actually finished
    ///      becoming the active one. The SAME scheduling also runs off
    ///      this window's own Activated event (see
    ///      DataEntryPopupWindow_OnActivated) — belt-and-suspenders for
    ///      the repeat-hotkey-press case, where the popup may already BE
    ///      the foreground window and so never re-raises Activated at
    ///      all; scheduling it twice is harmless (focusing the same
    ///      control again is a no-op).
    /// Every sub-step's outcome (GetForegroundWindow()==this window's
    /// handle, true/false) is logged via AppFileLog so the next real
    /// failure report says exactly which trick worked or didn't, instead
    /// of just "still doesn't focus."
    /// </summary>
    public void ActivateAndFocusCurrentStage()
    {
        if (Visibility != Visibility.Visible)
        {
            Show();
        }
        if (WindowState == WindowState.Minimized)
        {
            WindowState = WindowState.Normal;
        }

        Activate();

        var handle = new WindowInteropHelper(this).Handle;
        if (handle == IntPtr.Zero)
        {
            AppFileLog.Log("[Focus] ActivateAndFocusCurrentStage: no native handle yet after Activate() — skipping the rest of the foreground sequence.");
            ScheduleFocusCurrentStagePrimaryControl();
            return;
        }

        AppFileLog.Log($"[Focus] After Activate(): GetForegroundWindow()==hwnd is {IsThisWindowForeground(handle)}.");

        // Best-effort throughout: every Win32 call here returns
        // false/no-ops on failure rather than throwing (per each
        // function's own contract), and the sequence keeps going through
        // every remaining step regardless — the goal is "try everything
        // that can plausibly work," not "stop at the first thing that
        // didn't."
        AllowSetForegroundWindow(ASFW_ANY);
        AppFileLog.Log("[Focus] Called AllowSetForegroundWindow(ASFW_ANY).");

        TryAttachedSetForeground(handle);
        AppFileLog.Log($"[Focus] After attach-thread-input SetForegroundWindow/SetActiveWindow: GetForegroundWindow()==hwnd is {IsThisWindowForeground(handle)}.");

        if (!IsThisWindowForeground(handle))
        {
            TryAltNudgeThenSetForeground(handle);
            AppFileLog.Log($"[Focus] After the Alt-nudge fallback: GetForegroundWindow()==hwnd is {IsThisWindowForeground(handle)}.");
        }

        Topmost = false;
        Topmost = true;
        AppFileLog.Log($"[Focus] After toggling Topmost false->true: GetForegroundWindow()==hwnd is {IsThisWindowForeground(handle)}.");

        ScheduleFocusCurrentStagePrimaryControl();
    }

    private static bool IsThisWindowForeground(IntPtr handle) => GetForegroundWindow() == handle;

    /// <summary>Step 3 of ActivateAndFocusCurrentStage — see that method's
    /// doc comment. AttachThreadInput is ALWAYS paired with a matching
    /// detach in a finally block: leaving two threads' input state
    /// attached would make PioneerRx and this popup share keyboard/mouse
    /// input state indefinitely, not just for this one call.</summary>
    private void TryAttachedSetForeground(IntPtr handle)
    {
        var foreground = GetForegroundWindow();
        if (foreground == handle)
        {
            SetActiveWindow(handle);
            return;
        }

        var foregroundThreadId = foreground == IntPtr.Zero ? 0u : GetWindowThreadProcessId(foreground, out _);
        var currentThreadId = GetCurrentThreadId();
        var attached = false;
        try
        {
            if (foregroundThreadId != 0 && foregroundThreadId != currentThreadId)
            {
                attached = AttachThreadInput(currentThreadId, foregroundThreadId, true);
            }

            BringWindowToTop(handle);
            SetForegroundWindow(handle);
            SetActiveWindow(handle);
        }
        finally
        {
            if (attached)
            {
                AttachThreadInput(currentThreadId, foregroundThreadId, false);
            }
        }
    }

    /// <summary>Step 4 of ActivateAndFocusCurrentStage — see that method's
    /// doc comment for why a synthetic Alt keypress helps SetForegroundWindow
    /// succeed. Key DOWN then UP so Alt is never left logically stuck down
    /// for whatever application ends up with focus afterward.</summary>
    private static void TryAltNudgeThenSetForeground(IntPtr handle)
    {
        keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
        keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        SetForegroundWindow(handle);
        SetActiveWindow(handle);
    }

    /// <summary>Defers FocusCurrentStagePrimaryControl to
    /// DispatcherPriority.Input — see ActivateAndFocusCurrentStage's doc
    /// comment, step 6. Called both from there directly and from this
    /// window's own Activated event (DataEntryPopupWindow_OnActivated).</summary>
    private void ScheduleFocusCurrentStagePrimaryControl()
    {
        Dispatcher.BeginInvoke(DispatcherPriority.Input, new Action(FocusCurrentStagePrimaryControl));
    }

    /// <summary>MSG893 item 1: fires every time this window actually
    /// becomes the active window (including a re-activation from a repeat
    /// hotkey press) — see ActivateAndFocusCurrentStage's doc comment for
    /// why focus placement is scheduled from here rather than placed
    /// synchronously inside that method.</summary>
    private void DataEntryPopupWindow_OnActivated(object sender, EventArgs e)
    {
        ScheduleFocusCurrentStagePrimaryControl();
    }

    /// <summary>
    /// MSG893 item 1 (Will's brief, verbatim: "handle Deactivated -&gt; do
    /// nothing (never steal focus back)"): deliberately empty. The popup
    /// must never grab focus/foreground back on its own the moment the
    /// user clicks away from it (e.g. into PioneerRx to look something up
    /// mid-flow) — only an explicit re-trigger (the hotkey, or the "Open
    /// data entry popup" button, both of which call
    /// ActivateAndFocusCurrentStage) should ever bring it forward again.
    /// Kept as a named, documented no-op handler (rather than simply not
    /// wiring Deactivated at all) so a future reader sees this was a
    /// deliberate decision, not a missed hookup.
    /// </summary>
    private void DataEntryPopupWindow_OnDeactivated(object sender, EventArgs e)
    {
    }

    /// <summary>See ActivateAndFocusCurrentStage's REVIEWER FIX note.
    /// Group/Product/Dose fall back to doing nothing beyond the
    /// Activate()/SetForegroundWindow above if that stage's list happens
    /// to be empty (shouldn't normally happen — GoBack/BuildXOptions
    /// always populate before switching a stage's IsXStage true) rather
    /// than throwing.</summary>
    private void FocusCurrentStagePrimaryControl()
    {
        switch (_viewModel.CurrentStage)
        {
            case DataEntryPopupViewModel.Stage.Age:
                AgeTextBox.Focus();
                Keyboard.Focus(AgeTextBox);
                // MSG893 item 1 (Will's brief): select-all so a pharmacist
                // who lands back here after a repeat hotkey press can just
                // type over whatever's there instead of needing to clear it.
                AgeTextBox.SelectAll();
                break;
            case DataEntryPopupViewModel.Stage.Group:
                FocusFirstRadioButtonIn(GroupItemsControl);
                break;
            case DataEntryPopupViewModel.Stage.Product:
                FocusFirstRadioButtonIn(ProductItemsControl);
                break;
            case DataEntryPopupViewModel.Stage.Dose:
                FocusFirstRadioButtonIn(DoseItemsControl);
                break;
            case DataEntryPopupViewModel.Stage.Review:
                EnterIntoPioneerButton.Focus();
                Keyboard.Focus(EnterIntoPioneerButton);
                break;
        }
    }

    /// <summary>Walks the visual tree under an ItemsControl (Group/
    /// Product/Dose — see FocusCurrentStagePrimaryControl) to find and
    /// focus its first generated RadioButton. These lists have no single
    /// named control to Focus() directly (each row's RadioButton is
    /// generated per-item by a DataTemplate — see the Checked-handler doc
    /// comment on GroupRadioList_OnChecked), so a plain x:Name Focus()
    /// call the way AgeTextBox/EnterIntoPioneerButton use isn't available
    /// here. UpdateLayout() first forces container generation to run
    /// immediately rather than waiting for the next layout pass, so this
    /// works even if the stage just became visible this same call.</summary>
    private static void FocusFirstRadioButtonIn(ItemsControl itemsControl)
    {
        itemsControl.UpdateLayout();
        var radioButton = FindFirstVisualDescendant<RadioButton>(itemsControl);
        if (radioButton is null) return;

        radioButton.Focus();
        Keyboard.Focus(radioButton);
    }

    private static T? FindFirstVisualDescendant<T>(DependencyObject root) where T : DependencyObject
    {
        var childCount = VisualTreeHelper.GetChildrenCount(root);
        for (var i = 0; i < childCount; i++)
        {
            var child = VisualTreeHelper.GetChild(root, i);
            if (child is T match) return match;

            var descendant = FindFirstVisualDescendant<T>(child);
            if (descendant is not null) return descendant;
        }
        return null;
    }

    /// <summary>Enter in the age textbox is the fast path to the next
    /// question — same "keep it a fast textbox" reasoning as autofocus
    /// above. No-ops via CanExecute if the age isn't valid/present yet.</summary>
    private void AgeTextBox_OnKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key != Key.Enter) return;
        if (_viewModel.ContinueFromAgeCommand.CanExecute(null))
        {
            _viewModel.ContinueFromAgeCommand.Execute(null);
        }
    }

    /// <summary>
    /// V-... Part B: each of the guided flow's three RadioButton lists
    /// (group / product / dose) is a plain ItemsControl with its own
    /// per-row Checked="..." handler pointed at one of these three
    /// methods — same pattern the pre-guided-flow vaccine picker used
    /// (WPF has no built-in "SelectedItem" concept for a set of
    /// individually templated RadioButtons — a MultiBinding converter
    /// can't reach a row's own item either, ConverterParameter isn't
    /// bindable). `sender` is whichever RadioButton the user just checked;
    /// its DataContext (set by the DataTemplate) is that row's item.
    /// </summary>
    private void GroupRadioList_OnChecked(object sender, RoutedEventArgs e)
    {
        if (sender is RadioButton { DataContext: string group })
        {
            _viewModel.SelectGroup(group);
        }
    }

    private void ProductRadioList_OnChecked(object sender, RoutedEventArgs e)
    {
        if (sender is RadioButton { DataContext: VaccineProductOption product })
        {
            _viewModel.SelectProduct(product);
        }
    }

    private void DoseRadioList_OnChecked(object sender, RoutedEventArgs e)
    {
        if (sender is RadioButton { DataContext: Vaccine doseVaccine })
        {
            _viewModel.SelectDose(doseVaccine);
        }
    }
}
