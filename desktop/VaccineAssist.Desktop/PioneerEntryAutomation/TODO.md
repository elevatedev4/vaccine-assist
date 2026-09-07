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

## V-... update — start from Rx Profile (F3), quantity/directions, BUD gate, physician groups (2026-09-07)

Will's verbatim brief: "The data entry should start from the patient Rx
Profile, not from Add New Rx. So from that profile screen, push F3, then
two windows will open that have to be escaped from, Priority, and Scan
hard copy. Keep in mind, all of this is in the original macro I gave you.
Once on Add New Rx, you successfully got to enter the prescriber and
vaccine by NDC, but did not yet enter the quantity, directions, lot, or
expiration. Each vaccine will have its own quantity." Plus: entry must
HALT when the chosen vaccine's lot is expired OR past its beyond-use date.

- NEW `Sequencing/Steps/SendF3AndDismissPreEntryDialogsStep.cs` — runs
  right after FocusPioneerWindowStep: sends F3 to the attached Rx Profile
  window, then polls against a SINGLE SHARED deadline
  (`CombinedDialogsTimeout` = 8s, reviewer fix 2026-09-07 — see below) for
  windows titled like "Priority" and "Scan Hard Copy"
  (`Uia/PreEntryDialogTitles.cs`) and ESCs whichever is found on each tick,
  in whatever order they show up; a dialog that never appears (Will: "may
  be configured off on some machines") logs a warning and the step
  continues rather than hanging or failing. Re-attaches to the resulting
  "Add New Rx" window afterward — via a DEDICATED title+handle-exclusion
  lookup, not a plain PioneerRxAttachment.TryAttach() re-run (reviewer fix
  2026-09-07 — see below) — and overwrites context.AttachedWindow, since
  the Rx Profile reference FocusPioneerWindowStep captured is stale once
  F3 has been sent.
  **NOT CONFIRMED against a live UIA dump** — no dump of either dialog
  exists in this repo; the exact window titles are built directly from
  Will's own wording, not a captured screen. Confirm/adjust
  PreEntryDialogTitles.cs against a live dump before relying on this.
- NEW `Sequencing/Steps/InputQuantityStep.cs` — types
  `Models.Vaccine.Quantity` into `uxQuantityPrescribed` (the SAME
  AutomationId the 2026-09-05 dumps confirmed for InputVaccineCodeStep's
  own doc comment, which at the time deliberately did NOT type into it
  because it auto-populates from the drug record — that decision is
  REVERSED here per Will's explicit "each vaccine will have its own
  quantity"). Skips (no PioneerRx call) when Quantity is null — the
  `vaccines.quantity` column is a parallel migration not owned by this
  change; tolerate its absence.
- NEW `Sequencing/Steps/InputDirectionsStep.cs` — types
  `Models.Vaccine.Directions` into a PLACEHOLDER AutomationId
  (`uxDirections`) — no directions/sig field appeared in any of the six
  live dumps collected so far. Loud TODO in that file's own doc comment:
  confirm the real AutomationId against a live dump before relying on
  this; skips when Directions is null/blank, same posture as quantity.
- `PlaceholderVaccineEntrySequence.cs` step order is now: Focus → **F3 +
  dismiss dialogs (NEW)** → Select prescriber → Enter vaccine code →
  **Enter quantity (NEW)** → **Enter directions (NEW)** → Enter lot and
  expiration → Confirm entry.
- `Models/Lot.cs`: new `BeyondUseDate` (nullable, `lots.beyond_use_date` —
  parallel migration, tolerate absence) + `IsPastBeyondUseDate` (true when
  set and today-or-earlier). `DataEntryPopupViewModel.IsLotExpiredOrMissing`
  now also blocks on `IsPastBeyondUseDate`, and the popup's inline block
  message (`LotGateMessage`, replacing the old static XAML text) covers
  both "expired" and "past its beyond-use date," each explicitly telling
  staff to update the lot inline **and** "tell the pharmacist to update
  the VAR" (Will's brief, verbatim). `BuildPayloadAsync`'s FEFO lot query
  now also excludes BUD-past lots, not just expired ones.
- `Models/Vaccine.cs`: new `Quantity` (`decimal?`) and `Directions`
  (`string?`), mapping `vaccines.quantity`/`vaccines.directions` (parallel
  migration, tolerate absence).
- Physicians settings tab: rules can now target a whole VACCINE GROUP
  (`Models/VaccineGroupCatalog`'s existing groups), not just one specific
  vaccine or the true "any vaccine" wildcard. New
  `Models/PhysicianRuleVaccineOption.cs` backs a grouped ComboBox
  (group headers via WPF's native GroupStyle, "All &lt;group&gt; vaccines"
  first in each group, then that group's vaccines by name — see
  `PhysiciansViewModel.BuildVaccineOptions`/`VaccineOptionsView`).
  `Models/PhysicianRule.VaccineGroup` (nullable, `physician_rule.vaccine_group`
  — parallel migration, tolerate absence) is sent by
  `CreatePhysicianRuleAsync`'s new optional `vaccineGroup` parameter.
  New `Models/PhysicianRuleMatcher.cs` implements the specific > group >
  wildcard precedence as a pure, independently-tested function — see that
  file's own doc comment for why it is NOT (yet) wired into
  `DataEntryPopupViewModel.BuildLivePayloadAsync` in place of the existing
  `IVaccineApiService.ResolvePhysicianAsync` cloud call: that's a judgment
  call flagged for Will, not an oversight.

## V-... reviewer request-changes round (2026-09-07)

A parallel cloud branch (feat/cloud-tabs) landed the SERVER side of the
group-rule work above while this branch was in review: migration 0009
(`physician_rule.vaccine_group`), the specific > group > wildcard tier in
`cloud/lib/physician-resolution.ts`, group derivation in
`/api/physicians/resolve`, and — the piece this round's fix #1 depends on
— a `vaccineGroupSupported` flag on GET/POST/PATCH `/api/physician-rules`
that's `false` whenever the `vaccine_group` column doesn't exist yet on a
given database (schema-degradation fallback, same pattern
`hasActiveLot`/`eligibility` already use elsewhere in this app). Four
fixes from that review round, all in this branch, none touching cloud/:

1. **BLOCKING (safety)**: the desktop's "All &lt;group&gt; vaccines"
   ComboBox option is now HIDDEN unless the server's own
   `vaccineGroupSupported` flag says the column exists —
   `PhysiciansViewModel.VaccineGroupSupported` (read from the new
   `Models/PhysicianRulesResult.VaccineGroupSupported`,
   `GetPhysicianRulesAsync`'s new return shape) gates `BuildVaccineOptions`
   entirely, and `AddRuleAsync` has a belt-and-suspenders second check
   before ever sending a group. Reason: on a database still missing the
   column, a rule "saved" with only a group intent would persist as
   `vaccine_id=null` with no group at all — an UNRESTRICTED "any vaccine"
   wildcard, i.e. a silent over-grant of prescriber authority. Defaults to
   `false` (hide) before the first successful load and whenever the flag
   is unexpectedly absent from a response — fail CLOSED, not open; this is
   a deliberate divergence from the cloud web page's own more lenient
   `!== false` (defaults to shown) convention, since that page predates
   the flag and needs backward compatibility this brand-new desktop code
   doesn't. Physicians tab shows a short note ("vaccine-type rules
   available after the pending migration") when hidden. See
   `PhysiciansViewModelVaccineGroupSupportTests.cs`.
2. **BLOCKING**: `SendF3AndDismissPreEntryDialogsStep`'s dialog wait was
   order-dependent (waited out "Priority"'s own full timeout before ever
   checking "Scan Hard Copy", so a sequential/modal second dialog could be
   missed or the whole budget wasted on a dialog that's configured off).
   Rewritten to a single shared deadline (`CombinedDialogsTimeout` = 8s)
   with a set of pending titles, rescanning for ANY of them on every tick
   and removing each the moment it's dismissed — order-agnostic, and an
   immediate rescan after each dismissal catches a dialog that only
   appears once the first is gone. See that file's own doc comment
   (REVIEWER FIX notes) and `SendF3AndDismissPreEntryDialogsStepTests.cs`.
3. Robustness: the re-attach after F3 no longer just re-runs
   `PioneerRxAttachment.TryAttach()` (which matches "Rx Profile" AND
   "New Rx" both, first-candidate-wins with no ordering guarantee — could
   silently hand back the SAME stale Rx Profile window). New
   `TryAttachToAddNewRxWindow` (private to this step) requires the title
   to contain "New Rx" specifically AND excludes the previously-attached
   window's native handle (`FrameworkAutomationElement.NativeWindowHandle`,
   same pattern as rx-verify's `PioneerRxWindow.SafeNativeHandle`); fails
   loud (the step returns failure) if nothing distinct matches, rather
   than risking a silent wrong-window re-attach.
4. Doc-only: `InputVaccineCodeStep.cs`'s "NOT USED: Quantity..." comment
   was stale after `InputQuantityStep.cs` reversed that decision for
   `uxQuantityPrescribed` specifically — updated to cross-reference it
   (Days-Supply/Refills are still correctly NOT USED).
