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
