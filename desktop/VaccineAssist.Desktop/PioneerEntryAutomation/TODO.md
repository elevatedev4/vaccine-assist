# PioneerEntryAutomation — wiring it up for real

Phase 1 shipped `IPioneerEntryAutomation` + `PioneerEntryAutomationStub` only
(still true, untouched by V-T3 below). `TryAttachAsync` always returns
`false`, so the Entry screen (Views/EntryView.xaml, the left-nav "Entry"
page) always falls back to its clipboard-payload flow
(`VaccineEntryPayload.ToClipboardPayload()` — the same `code,lot,exp`
string the old macro read from `%vaccinedata%`, shown on screen and copied
to the clipboard for a staff member to paste).

## V-T3 update (data-entry mode / Ctrl+NumPad2) — 2026-08-19

The headline feature ("replacing my macro") is now built as a SEPARATE
flow from the Entry screen above: `Hotkeys/GlobalHotKey.cs` registers
Ctrl+NumPad2 (MainWindow.xaml.cs), which shows
`Views/DataEntryPopupWindow.xaml` (`ViewModels/DataEntryPopupViewModel.cs`)
— vaccine + age only, `Validate` against the existing
`/api/eligibility/evaluate` call, then `Enter into Pioneer`.

That button runs `Sequencing/PlaceholderVaccineEntrySequence` via
`Sequencing/PioneerEntrySequenceRunner` — a NEW, more granular
abstraction than `IPioneerEntryAutomation` above (`IPioneerEntrySequence`
= an ordered list of `IPioneerEntryStep`s, each with its own dry-run
handling, logging, and pass/fail result). This is what's now
"cleanly pluggable" per the original brief:

- `Sequencing/Steps/FocusPioneerWindowStep.cs` is REAL — attaches via
  `Uia/PioneerRxAttachment.cs` (FlaUI UIA3, modeled on rx-verify's
  `PioneerRxWindow.TryAttach`).
- `NavigateToVaccineFieldsStep` / `InputVaccineCodeStep` /
  `InputLotAndExpirationStep` / `ConfirmEntryStep` are STILL STUBBED —
  each returns a failed `PioneerEntryStepResult` with a
  `PENDING-MACRO-FILE` message in live mode, and a "would do X" log line
  in dry-run mode. Wiring them for real is what's below, unchanged from
  before this update.

Still not designed at all: the Medicare home-visit special case (item 3
below) — no popup field for it yet, same reason as before (no live
target).

## V-... update — UIA tree-dump collector shipped (2026-09-05)

The app now has its own one-click UIA tree-dump collector, so getting the
live dumps this file has been blocked on all along no longer needs
Accessibility Insights or a separate tool: `Uia/UiaTreeDumper.cs`, wired to
a "Dump Pioneer UIA tree" button on both the Data entry tab (main window)
and the Ctrl+NumPad2 popup. It walks the ENTIRE tree of whichever PioneerRx
window is currently attached (same widened match `FocusPioneerWindowStep`
uses) and writes a timestamped text dump to
`%AppData%\VaccineAssist\uia-dumps\` (path copied to clipboard, README in
that folder explains the PHI handling). Once real dumps exist for the
vaccine-entry screen(s), THIS is the data `TryAttach`'s title/process match
and the stubbed steps below should be confirmed/rewritten against — see the
Will-facing collection instructions posted alongside this change.

Real automation needs to happen live, on the pharmacy's own machine, against
a real PioneerRx window — it can't be built or tested from here. When that
happens, follow the pattern already proven in the `rx-verify` repo rather
than inventing a new one:

## What to copy from rx-verify

- **`overlay/RxVerifyOverlay/Uia/PioneerRxWindow.cs`** — finds and attaches
  to the active PioneerRx window using FlaUI's UIA3 API
  (`FlaUI.Core.AutomationElements.AutomationElement`,
  `FlaUI.UIA3.UIA3Automation`). This is the direct analog of
  `TryAttachAsync` above — same "find the window, cache the handle" shape,
  just attaching to whatever window title/pattern the vaccine
  administration form actually uses (not the Rx Profile/e-script windows
  rx-verify attaches to).
- **`overlay/RxVerifyOverlay/Uia/FieldMap.cs`** — the header comment there
  explains the two real UIA tree dumps that file's field lookups were
  confirmed against. Do the same thing here first: dump the vaccine admin
  form's UIA tree (FlaUI has an `Inspect`-like tool, or use Windows'
  Accessibility Insights) before writing any field-lookup code, rather
  than guessing AutomationIds or screen coordinates.
- **`overlay/RxVerifyOverlay/Uia/RetryingFieldRead.cs`** — PioneerRx's UI
  doesn't always paint synchronously; reads should retry briefly rather
  than fail on the first miss. The same will likely be true for whatever
  window this app ends up driving.
- **`overlay/RxVerifyOverlay/RxVerifyOverlay.csproj`** — the exact
  `FlaUI.Core` / `FlaUI.UIA3` PackageReference versions already proven to
  work in this environment.

## What NOT to copy

- rx-verify's OCR pieces (`Ocr/`) — that's for reading a **rendered image**
  of an e-script when UIA fields aren't reliably readable. There's no
  reason to expect the vaccine admin form needs that; start with plain
  UIA and only reach for OCR if a specific field turns out to be a
  not-focusable/painted-only control.
- rx-verify's overlay/click-through positioning (`Integrated/`) — this app
  isn't drawing anything on top of PioneerRx, it's just typing into a form.

## Shape to fill in

1. `TryAttachAsync`: find the vaccine administration window (title/class
   TBD from a live dump), same pattern as `PioneerRxWindow.TryAttach`.
2. `EnterVaccineAsync`: replicate vaccine-add-new.mxe's final keystroke
   sequence (lines 298-337 of the original .mxe — ESC, type the vaccine
   short code, ENTER, ALT+O, type lot, TAB, type expiration, TAB, "w",
   TAB) but via UIA `Invoke`/`SetValue` patterns on the actual controls
   instead of blind keystrokes wherever the controls support it — more
   robust than SendKeys-style automation, same reasoning rx-verify's UIA
   approach is built on.
3. The Medicare home-visit special case (macro lines 79-80, 322-325 — a
   multiple-choice reason prompt whose answer gets written into the
   signature field) has no equivalent UI in this app yet. Decide then
   whether it's a dialog on the Entry screen or handled some other way —
   not designed here since there's no live target to validate against.

## V-... update — wired for real against the SIX live UIA dumps (2026-09-05)

Will collected six live dumps of PioneerRx's Rx Profile + progressively-
filled-in "Add New Rx" screens using the tree-dump collector above (the
thing every section above was blocked on). Everything except item 3
(Medicare home visit — still no live target) is now wired:

- `Uia/PioneerRxTitles.cs`: added `"Rx Profile"` as a confirmed window
  title prefix (the vaccine-entry precondition turned out to be "the
  patient's Rx Profile is open" through "an Add New Rx is in progress" —
  `"New Rx"` already matched `"Add New Rx"` via the existing Contains
  widening).
- `Sequencing/Steps/NavigateToVaccineFieldsStep.cs` was RENAMED to
  `SelectPrescriberStep.cs` — the real "Add New Rx" screen needs no
  separate navigation step (every field is already visible), so its real
  job is typing the resolved physician's alternate ID into
  `uxPrescriberQuickSearch` and pressing ENTER twice (Will's own
  described workflow). AutomationId cross-confirmed against rx-verify's
  independent `FieldMap.EnteredPrescriberQuickSearchId`.
- `InputVaccineCodeStep.cs` types the vaccine's NDC (not the old macro
  short code) into `uxPrescribedItemQuickSearch`, ENTER twice. Quantity/
  days-supply/refills are deliberately NOT wired — the dumps show they
  auto-populate from the drug record once it's selected.
- `InputLotAndExpirationStep.cs` types lot + expiration (plain text, no
  ENTER) into `uxLotNumber` / `uxLotExpirationDate`, reformatting
  `ExpirationMacroFormat` (MMDDYYYY) to PioneerRx's own `M/d/yyyy` shape
  first (`ToPioneerDateFormat`, confirmed against the live value
  "9/5/2027").
- `ConfirmEntryStep.cs`: the dumps DO show an explicit, unambiguous
  control — `uxSave` ("Save & Continue - F12") — but clicking it submits
  the entire new Rx into PioneerRx's real fill/pre-check pipeline, a
  bigger action than "confirm this vaccine's data" alone. Per the
  explicit safety brief ("never auto-confirm a final save... this writes
  to his real pharmacy system"), this step locates the button and
  confirms it's there but does NOT click it — flagged as a judgment call
  worth Will's explicit confirmation either way.
- New: `Steps/QuickSearchFieldEntry.cs` (shared find-by-AutomationId +
  SetValue + FocusNative + N×ENTER helper), `Models/Physician.cs` /
  `Models/PhysicianRule.cs` + a Physicians settings tab (protocol
  physicians + vaccine/age-range assignment rules, backed by
  `supabase/migrations/0007_physicians.sql` + `cloud/lib/physician-resolution.ts`)
  that `DataEntryPopupViewModel.BuildLivePayloadAsync` resolves against
  before every live entry — no matching rule blocks entry with a message
  pointing back at that tab.
- `Uia/UiaTreeDumper.cs`'s dump button now copies the DUMP TEXT itself to
  the clipboard (Will: "so I don't have to go find it in the file"), not
  just the saved file path — the file is still written too.

STILL UNVERIFIABLE from here (no Windows/PioneerRx in this dev
environment): whether `FindFirstDescendant(cf => cf.ByAutomationId(...))`
actually resolves each of these controls live, whether `SetValue` +
`Keyboard.Type(VirtualKeyShort.RETURN)` really selects the intended
prescriber/drug the way plain human typing does (PioneerRx's quick-search
match/selection behavior on a partial or ambiguous alternate ID/NDC isn't
something a static UIA dump can prove), and whether `FocusNative()`
reliably focuses these specific WinForms controls. First live run should
be watched closely — see PlaceholderVaccineEntrySequence.cs's own doc
comment for the exact step order.
