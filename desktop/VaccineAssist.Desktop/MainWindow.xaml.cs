using System;
using System.Runtime.InteropServices;
using System.Windows;
using VaccineAssist.Desktop.Hotkeys;
using VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing;
using VaccineAssist.Desktop.Services;
using VaccineAssist.Desktop.Uia;
using VaccineAssist.Desktop.ViewModels;
using VaccineAssist.Desktop.Views;

namespace VaccineAssist.Desktop;

/// <summary>
/// Shell hosting the five post-login tabs (Scheduling, Data entry, Lots,
/// Active vaccines, Ordering — see MainWindow.xaml). Navigation is a plain
/// TabControl; each tab's content is set once in the constructor via
/// imperative code-behind (no navigation framework, no DataTemplate
/// view-model-first matching) — consistent with this app's DI-light,
/// manually-composed style (see App.xaml.cs).
///
/// Also owns the V-T3 global hotkey (Ctrl+NumPad7): registered here
/// (not a standalone window) since MainWindow is the one window that
/// stays open for the whole signed-in session — the hotkey should work
/// no matter which tab is currently showing.
///
/// 2026-09-13: also owns a second, independent global hotkey — Ctrl+Keypad 8 —
/// for the macro-codes popup (Will's brief). Same reasoning for living on
/// MainWindow as the data-entry hotkey above; the two GlobalHotKey
/// instances are otherwise unrelated (distinct ids, distinct vk, distinct
/// popups) and neither's registration/lifecycle affects the other's.
/// </summary>
public partial class MainWindow : Window
{
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    private readonly LotsViewModel _lotsViewModel;
    private readonly SchedulingViewModel _schedulingViewModel;
    private readonly OrderingViewModel _orderingViewModel;
    private readonly EntryViewModel _entryViewModel;
    private readonly VaccinesViewModel _vaccinesViewModel;
    private readonly PhysiciansViewModel _physiciansViewModel;
    private readonly IAuthService _authService;
    private readonly IVaccineApiService _vaccineApiService;
    private readonly IClipboardService _clipboardService;
    private readonly IPioneerEntrySequence _pioneerEntrySequence;
    private readonly string _cloudApiBaseUrl;
    private GlobalHotKey? _dataEntryHotKey;
    private GlobalHotKey? _macroCodesHotKey;

    /// <summary>
    /// The currently-open data-entry popup, if any — at most one can be
    /// open at a time. MSG893 item 2 changed ShowDataEntryPopup to
    /// actively enforce that (re-activate/re-focus this instance instead
    /// of opening a second one) rather than merely tracking it; see that
    /// method's doc comment. Also lets MainWindow explicitly close it on
    /// sign-out/window-close (see MainWindow_OnClosed and
    /// LogoutButton_OnClick) now that it's no longer an owned window (see
    /// ShowDataEntryPopup's doc comment on removing Owner=this) — without
    /// this, the popup would survive past logout, left bound to a
    /// DataEntryPopupViewModel/IVaccineApiService whose bearer token is
    /// now stale (calls would just start 401ing). Cleared via the popup's
    /// own Closed event so a user closing it normally doesn't leave a
    /// stale reference or cause a double-Close.
    /// </summary>
    private DataEntryPopupWindow? _openDataEntryPopup;

    /// <summary>
    /// The currently-open macro-codes popup, if any — same "at most one at
    /// a time, re-activate rather than stack" rule as _openDataEntryPopup
    /// above (see ShowMacroCodesPopup), and same reason MainWindow needs
    /// to explicitly close it on sign-out/window-close (MainWindow_OnClosed):
    /// it's not an owned window, so nothing else would clean it up.
    /// </summary>
    private MacroCodesWindow? _openMacroCodesPopup;

    /// <summary>Process-unique id for RegisterHotKey — arbitrary but must not collide with another hotkey id this process registers.</summary>
    private const int DataEntryHotKeyId = 1;

    /// <summary>Process-unique id for the Ctrl+Keypad 8 macro-codes hotkey's RegisterHotKey call — must differ from DataEntryHotKeyId (the only other id this process registers).</summary>
    private const int MacroCodesHotKeyId = 2;

    public MainWindow(
        LotsViewModel lotsViewModel,
        VaccinesViewModel vaccinesViewModel,
        IAuthService authService,
        IVaccineApiService vaccineApiService,
        IClipboardService clipboardService,
        IPioneerEntrySequence pioneerEntrySequence,
        string cloudApiBaseUrl)
    {
        InitializeComponent();
        _lotsViewModel = lotsViewModel;
        _vaccinesViewModel = vaccinesViewModel;
        _authService = authService;
        _vaccineApiService = vaccineApiService;
        _clipboardService = clipboardService;
        _pioneerEntrySequence = pioneerEntrySequence;
        _cloudApiBaseUrl = cloudApiBaseUrl;

        _schedulingViewModel = new SchedulingViewModel(_vaccineApiService);
        _orderingViewModel = new OrderingViewModel(_vaccineApiService);
        _entryViewModel = new EntryViewModel(ShowDataEntryPopup, _clipboardService);
        _physiciansViewModel = new PhysiciansViewModel(_vaccineApiService);

        SchedulingContent.Content = new SchedulingView(_schedulingViewModel);
        DataEntryTabContent.Content = new EntryView(_entryViewModel);
        LotsContent.Content = new LotsView(_lotsViewModel);
        // Active vaccines now hosts VaccinesView — adapted 2026-08-19 from
        // the old read-only catalog grid into the admin view (active +
        // inactive, "current lot" indicator, editable/persisted Active
        // toggle; see VaccinesViewModel).
        ActiveVaccinesContent.Content = new VaccinesView(_vaccinesViewModel);
        // Ordering — reorder recommendations from GET
        // /api/ordering/recommendation (see OrderingViewModel). Replaces
        // the static placeholder that used to live directly in
        // MainWindow.xaml.
        OrderingContent.Content = new OrderingView(_orderingViewModel);
        // Physicians — protocol physicians + vaccine/age assignment rules
        // (Will, 2026-09-05: see PhysiciansViewModel's doc comment).
        PhysiciansContent.Content = new PhysiciansView(_physiciansViewModel);

        SourceInitialized += MainWindow_OnSourceInitialized;
        Closed += MainWindow_OnClosed;
    }

    /// <summary>Raised after a successful sign-out — App.xaml.cs shows a
    /// fresh LoginWindow and closes this one.</summary>
    public event EventHandler? LoggedOut;

    /// <summary>
    /// Registers Ctrl+NumPad7 once this window has a native handle. A
    /// failed registration (e.g. another app already owns that
    /// combination) is surfaced once via a status-bar-free MessageBox
    /// rather than silently doing nothing — a hotkey that looks
    /// registered but never fires would be a confusing "the headline
    /// feature just doesn't work" bug report. The same true/false result
    /// also drives the Data entry tab's status indicator (EntryViewModel.
    /// IsHotkeyActive) so it's visible without needing to reproduce the
    /// failure to notice it.
    /// </summary>
    private void MainWindow_OnSourceInitialized(object? sender, EventArgs e)
    {
        _dataEntryHotKey = new GlobalHotKey(this, DataEntryHotKeyId);
        _dataEntryHotKey.Pressed += (_, _) => ShowDataEntryPopup();

        var registered = _dataEntryHotKey.Register();
        _entryViewModel.IsHotkeyActive = registered;

        if (!registered)
        {
            MessageBox.Show(
                this,
                "Couldn't register the Ctrl+NumPad7 data-entry hotkey — it may already be in use by another application. " +
                "You can still open the popup from the Data entry tab.",
                "Vaccine Assist",
                MessageBoxButton.OK,
                MessageBoxImage.Warning);
        }

        // 2026-09-13: Ctrl+Keypad 8 macro-codes popup — a second, independent
        // GlobalHotKey instance (distinct id, distinct vk) registered the
        // exact same way as the data-entry hotkey above, right down to the
        // failure handling (a one-time MessageBox; the popup just isn't
        // reachable via the hotkey if this fails — there's no separate
        // button for it the way the Data entry tab has one).
        _macroCodesHotKey = new GlobalHotKey(this, MacroCodesHotKeyId, GlobalHotKey.VK_NUMPAD8);
        _macroCodesHotKey.Pressed += (_, _) => ShowMacroCodesPopup();

        var macroCodesRegistered = _macroCodesHotKey.Register();
        if (!macroCodesRegistered)
        {
            MessageBox.Show(
                this,
                "Couldn't register the Ctrl+Keypad 8 macro-codes hotkey — it may already be in use by another application.",
                "Vaccine Assist",
                MessageBoxButton.OK,
                MessageBoxImage.Warning);
        }
    }

    private void MainWindow_OnClosed(object? sender, EventArgs e)
    {
        _dataEntryHotKey?.Dispose();
        _dataEntryHotKey = null;

        _macroCodesHotKey?.Dispose();
        _macroCodesHotKey = null;

        // Covers both exit paths: MainWindow closing directly (chrome/
        // Alt+F4) and Sign out (LogoutButton_OnClick -> App.xaml.cs's
        // LoggedOut handler calls mainWindow.Close(), which raises this
        // same Closed event) — see _openDataEntryPopup's doc comment for
        // why an orphaned popup is a real problem, not just cosmetic.
        _openDataEntryPopup?.Close();
        _openDataEntryPopup = null;

        _openMacroCodesPopup?.Close();
        _openMacroCodesPopup = null;
    }

    /// <summary>
    /// V-T3 item 2: light presence check first (Uia/PioneerRxPresence —
    /// cheap, no FlaUI/UIA session), then show the popup regardless of
    /// the result — a pharmacist who fat-fingers the hotkey before
    /// switching to PioneerRx still gets a usable popup (it defaults to
    /// dry run and says so; see DataEntryPopupViewModel's constructor)
    /// rather than nothing happening at all.
    ///
    /// Deliberately touches nothing on MainWindow itself — no Show,
    /// Activate, WindowState, or Visibility change, and no Owner
    /// assignment either. Will's feedback (2026-08-19): "don't make
    /// 'Vaccine Assist' pop up when data entry is happening, just the one
    /// popup window." MainWindow is already Show()n and visible as the
    /// normal app shell (it now hosts the 5 working tabs, so hiding it
    /// permanently per-session isn't right here), so the previous code's
    /// `Owner = this` on the popup was the actual bug: Win32 always keeps
    /// an owned window's owner above other non-owned windows in z-order,
    /// so showing the (Topmost, activated) popup also pulled MainWindow's
    /// z-position up along with it — visible as "Vaccine Assist popping
    /// up" if it had been sitting behind PioneerRx. The popup doesn't
    /// need Owner to stay on top of PioneerRx: it already sets
    /// Topmost="True" and ShowInTaskbar="False" itself (see
    /// DataEntryPopupWindow.xaml).
    ///
    /// MSG893 item 2 (2026-09-07-ish): if the popup is ALREADY open (a
    /// repeat hotkey press, or the "Open data entry popup" button clicked
    /// again), re-activate and re-focus that SAME instance
    /// (DataEntryPopupWindow.ActivateAndFocusCurrentStage) instead of opening a
    /// second one — a pharmacist who presses the hotkey again because the
    /// first press didn't visibly grab focus should land back in the age
    /// box, not get a confusing stack of popups. This is a deliberate
    /// change from the previous "multiple popups can stack, unchanged"
    /// behavior.
    /// </summary>
    private void ShowDataEntryPopup()
    {
        if (_openDataEntryPopup is not null)
        {
            _openDataEntryPopup.ActivateAndFocusCurrentStage();
            return;
        }

        var pioneerDetected = PioneerRxPresence.IsPresent();
        var viewModel = new DataEntryPopupViewModel(_vaccineApiService, _clipboardService, _pioneerEntrySequence, pioneerDetected);
        var popup = new DataEntryPopupWindow(viewModel);

        // Tracked so MainWindow_OnClosed can explicitly close this popup
        // on sign-out/window-close rather than leaving it orphaned (see
        // _openDataEntryPopup's doc comment), and so a repeat hotkey press
        // above re-activates this instance instead of opening a duplicate.
        popup.Closed += (_, _) =>
        {
            if (ReferenceEquals(_openDataEntryPopup, popup))
            {
                _openDataEntryPopup = null;
            }
        };
        _openDataEntryPopup = popup;

        popup.Show();
    }

    /// <summary>
    /// Ctrl+Keypad 8 (Will, 2026-09-13). Same "at most one instance, re-activate
    /// instead of stacking" rule as ShowDataEntryPopup above — see
    /// _openMacroCodesPopup's doc comment. Captures the current foreground
    /// window (typically PioneerRx, if that's what the pharmacist was
    /// working in) via GetForegroundWindow() BEFORE showing the popup, so
    /// MacroCodesWindow can restore it on close — see that window's
    /// constructor/Closed handler.
    /// </summary>
    private void ShowMacroCodesPopup()
    {
        if (_openMacroCodesPopup is not null)
        {
            _openMacroCodesPopup.BringToFront();
            return;
        }

        var previousForegroundWindow = GetForegroundWindow();
        var popup = new MacroCodesWindow(_cloudApiBaseUrl, _clipboardService, previousForegroundWindow);

        popup.Closed += (_, _) =>
        {
            if (ReferenceEquals(_openMacroCodesPopup, popup))
            {
                _openMacroCodesPopup = null;
            }
        };
        _openMacroCodesPopup = popup;

        popup.Show();
    }

    private async void LogoutButton_OnClick(object sender, RoutedEventArgs e)
    {
        await _authService.SignOutAsync();
        LoggedOut?.Invoke(this, EventArgs.Empty);
    }
}
