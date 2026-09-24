# Data-entry macro reference (V-T41)

Will's original PioneerRx data-entry automation was a Macro Express script,
**`vaccine-add-new.mxe`**. That file itself is **not in this repo** (recon
confirmed this — see "What's NOT here" below) — everything below is
reconstructed from every place the codebase quotes specific lines/behavior
of it, plus Will's own verbatim descriptions of the workflow across
several rounds of feedback. This doc exists so the CODE (the step classes
under `Sequencing/Steps/`) and the MACRO (this list) can be compared step
by step — see "Side-by-side: macro vs. current code" below.

## What's NOT here

- The literal `.mxe` script contents/keystroke opcodes beyond what's
  quoted piecemeal in code comments (see "Sources" below). No one has
  found or re-uploaded the original file since automation work started
  (`PioneerEntryAutomation/TODO.md`'s own "PRIORITY POPUP FIX" note:
  "Recon for that macro file ... found neither anywhere in this repo").
- A live UI Automation (UIA) tree dump of the "Priority", "Scan Hard
  Copy", and "Patient on Cycle Fill" pre-entry dialogs, or of the
  directions/SIG field, or of any administration-site (left/right arm)
  signature field. Every AutomationId marked "CONFIRMED" below was
  cross-checked against six live dumps of PioneerRx's Rx Profile /
  progressively-filled "Add New Rx" screen, collected 2026-09-05 (see
  `Uia/UiaTreeDumper.cs`); everything marked "UNCONFIRMED" was not.

## Sources (grep terms, so this stays checkable)

- `PioneerEntryAutomation/TODO.md` — quotes macro line numbers directly:
  lines 32-36 (`%vaccinedata%` clipboard format), 49-66 (admin-site
  letter code), 79-80 & 322-325 (Medicare home-visit prompt), 298-337
  (final keystroke sequence: "ESC, type the vaccine short code, ENTER,
  ALT+O, type lot, TAB, type expiration, TAB, 'w', TAB").
- `PioneerEntryAutomation/VaccineEntryPayload.cs` (doc comments on
  `ShortCode`/`ToClipboardPayload`) — the macro's `%vaccinedata%` format:
  `code,lot,exp` (MMDDYYYY).
- `Models/AdminSite.cs` — the macro validated administration site as
  exactly `"l"` or `"r"`, expanded to "left arm"/"right arm" for
  PioneerRx's signature field (macro lines 49-66).
- `Sequencing/Steps/ConfirmEntryStep.cs` — Medicare home-visit special
  case reference (macro lines 79-80, 322-325).
- `Sequencing/Steps/SendF3AndDismissPreEntryDialogsStep.cs` (class doc
  comment) — Will, 2026-09-07: "The data entry should start from the
  patient Rx Profile, not from Add New Rx. So from that profile screen,
  push F3, then two windows will open that have to be escaped from,
  Priority, and Scan hard copy... Keep in mind, all of this is in the
  original macro I gave you." And 2026-09-13: "It's getting stuck because
  it's missing the 'Priority' popup ... It needs to set the priority to
  Vaccine when that window comes up. All of this should've been in the
  original macro file I sent you."
- `cloud/app/data-entry/instructions.tsx` — the current user-facing entry
  point (Ctrl+Keypad 7), confirmed against `Hotkeys/GlobalHotKey.cs`
  (VK_NUMPAD7).
- Will's 2026-09-22 brief (V-T41, this round): "revisit the original
  macro, which explicitly spells out a lot of the steps. Right now it's
  getting 'Vaccine' correctly on the priority, but then getting stuck."

## The macro's step list (reconstructed)

1. **Trigger**: pharmacist opens the patient's Rx Profile in PioneerRx,
   then runs the macro (now replaced by the desktop app's
   **Ctrl+Keypad 7** hotkey — see `cloud/app/data-entry/instructions.tsx`
   and `Hotkeys/GlobalHotKey.cs`'s `VK_NUMPAD7`).
2. **F3** — starts "Add New Rx" from the open Rx Profile.
3. Two (really three) pre-entry dialogs can appear and must be
   dismissed/answered before the Add New Rx screen is usable:
   - **"Priority"** — NOT simply dismissed. The macro **sets it to
     "Vaccine"** (a selection, not an Escape) — Will, 2026-09-13: "It
     needs to set the priority to Vaccine when that window comes up."
   - **"Scan Hard Copy"** — Escaped/dismissed.
   - **"Patient on Cycle Fill"** — Escaped/dismissed (added later,
     MSG893 hotfix — may not appear on every machine/configuration;
     Will: "may be configured off on some machines").
4. **Prescriber**: on the "Written By:" field, type the physician's
   Pioneer **alternate ID**, then press **ENTER twice** to select that
   prescriber (Will, 2026-09-05, verbatim: "On the physician line, you
   would enter the alternate ID, then push enter twice to select that
   prescriber").
5. **Drug/vaccine**: type the vaccine's code into the item quick-search,
   then **ENTER twice**. (The macro's own short code, e.g. `"mmr1"` — see
   `supabase/seed/vaccines.sql` — vs. the NDC the current code types
   instead; see "Known divergences" below.)
6. **Quantity**: this vaccine's quantity (per-vaccine, not a fixed
   value — Will, 2026-09-07: "Each vaccine will have its own quantity").
7. **Directions/SIG**: this vaccine's directions (some workflows leave
   this for later — see `InputDirectionsStep`'s Skip option).
8. **Lot and expiration**, from the final keystroke sequence quoted in
   `TODO.md` (macro lines 298-337): **ESC**, type the vaccine short
   code, **ENTER**, **ALT+O**, type lot, **TAB**, type expiration,
   **TAB**, `"w"`, **TAB**.
   - The literal `ESC, type short code, ENTER` at the start of this
     sequence looks like it re-confirms/re-opens the drug line before
     touching lot/expiration (context lost without the actual `.mxe`
     file) — not reproduced as a separate step in the current code,
     which instead relies on the drug quick-search from step 5 already
     having resolved the same drug record. Flagged here, not guessed at.
   - **ALT+O** opens whatever dialog/panel actually holds the lot/
     expiration fields in the macro's PioneerRx version. The CURRENT
     code (`InputLotAndExpirationStep`) does not send Alt+O at all — it
     types directly into `uxLotNumber`/`uxLotExpirationDate` via UIA,
     confirmed present directly on the Add New Rx screen's Dispense tab
     in the 2026-09-05 live dumps with no separate dialog needed. Either
     PioneerRx's UI changed since the macro was written (most likely,
     per the dumps), or Alt+O opens something adjacent (e.g. an "Other
     info" panel) not required for lot/expiration specifically. Not
     reproduced literally since the live dumps show it isn't needed —
     flagged, not silently dropped.
   - **`"w"`** after the second TAB, before the final TAB: unexplained
     without the original file — possibly a one-letter macro trigger, a
     unit abbreviation, or a leftover keystroke from a different field
     that happened to be focused next. Not reproduced.
   - **Admin site** (left/right arm): the macro asks for `"l"` or `"r"`
     and writes "left arm"/"right arm" into PioneerRx's **signature
     field** (macro lines 49-66, `Models/AdminSite.cs`). No signature
     field was identified in any of the six live dumps collected so far
     — `VaccineEntryPayload.AdminSiteDisplayText` is computed
     (`AdminSite` is fixed to `LeftArm` per Will's 2026-08-19/20 "remove
     Right Arm" — see `DataEntryPopupViewModel`'s class doc comment) but
     **never typed anywhere**. This is a known, explicit gap — see
     "Known gaps" below, not something this round changed.
9. **Medicare home-visit special case** (macro lines 79-80, 322-325): a
   multiple-choice reason prompt whose answer gets written into the
   signature field, for a `"medicarehomevisit"` product code. No
   equivalent UI/flow exists yet — `ConfirmEntryStep.cs`'s own doc
   comment tracks this as still undesigned (no live target to validate
   the real UI against).
10. **Save**: the macro presumably completed the Rx save itself. The
    current code deliberately **stops short** of this — see
    `ConfirmEntryStep.cs`: it confirms PioneerRx's `uxSave` ("Save &
    Continue - F12") button is present and invokable but does **not**
    click it, per Will's explicit safety brief ("never auto-confirm a
    final save ... this writes to his real pharmacy system").

## Side-by-side: macro vs. current code

| # | Macro step | Current step class | AutomationId / mechanism | Status |
|---|---|---|---|---|
| 1 | Trigger from Rx Profile | Ctrl+Keypad 7 hotkey (`GlobalHotKey`, `VK_NUMPAD7`) | n/a | Live, matches |
| 2 | F3 | `SendF3AndDismissPreEntryDialogsStep` (first half) | `Keyboard.Type(VirtualKeyShort.F3)` on the attached Rx Profile window | CONFIRMED (F3 keypress itself; not a UIA lookup) |
| 3a | "Priority" → set to Vaccine | `SendF3AndDismissPreEntryDialogsStep.TryHandlePriorityIfShowing`/`ResolvePriorityDialog` | Layered strategy: UIA ComboBox/List select, else raw-view select, else focus+type "Vaccine"+Enter (keyboard fallback) — verified closed (`VerifyDialogGone`) before declaring success | UNCONFIRMED control shape (no live dump of this dialog) but Will confirms this part now works ("getting 'Vaccine' correctly on the priority") — **kept as-is this round** |
| 3b | "Scan Hard Copy" → dismiss | same step, `PreEntryDialogTitles.ScanHardCopy` | ESC | UNCONFIRMED against a live dump |
| 3c | "Patient on Cycle Fill" → dismiss | same step, `PreEntryDialogTitles.PatientOnCycleFill` | ESC | UNCONFIRMED against a live dump |
| 4 | Prescriber alternate ID + Enter×2 | `SelectPrescriberStep` | `uxPrescriberQuickSearch` (Edit, Value pattern) | CONFIRMED (2026-09-05 dumps + rx-verify cross-check) |
| 5 | Vaccine code + Enter×2 | `InputVaccineCodeStep` | `uxPrescribedItemQuickSearch` (types the **NDC**, not the macro's short code — see "Known divergences") | CONFIRMED |
| 6 | Quantity | `InputQuantityStep` | `uxQuantityPrescribed` — falls back to a cloud catalog default (V-T41 item 3, this round) before prompting staff | CONFIRMED field; default-fallback NEW this round |
| 7 | Directions/SIG | `InputDirectionsStep` | `uxDirections` — same catalog-default fallback added this round | **UNCONFIRMED AutomationId** — placeholder, no live dump shows this field |
| 8a | Lot | `InputLotAndExpirationStep` | `uxLotNumber` (Edit, Value pattern), typed directly (no Alt+O) — now read back and verified after typing (V-T41 item 4, this round) | CONFIRMED field; readback verification NEW this round |
| 8b | Expiration | same step | `uxLotExpirationDate`, MMDDYYYY → `M/d/yyyy` — now read back and verified | CONFIRMED field; readback verification NEW this round |
| 8c | Admin site (left/right arm → signature field) | *(none)* | n/a | **NOT WIRED** — known gap, see above |
| 9 | Medicare home-visit reason prompt | *(none)* | n/a | **NOT DESIGNED** — no live target |
| 10 | Save | `ConfirmEntryStep` | `uxSave`, located but deliberately **not clicked** | CONFIRMED field; click withheld on purpose (safety) |

## Known divergences from the macro (deliberate, documented elsewhere)

- **NDC instead of short code** for the drug/vaccine field
  (`InputVaccineCodeStep`) — the live dumps showed the quick-search
  resolves off the NDC on the real Add New Rx screen; the macro's short
  code (`ShortCode`) is kept only for `VaccineEntryPayload.ToClipboardPayload()`'s
  legacy clipboard format.
- **UIA field lookups instead of blind keystrokes** wherever a control
  supports the UIA Value pattern (`SetValue`) — `TODO.md`'s own "Shape to
  fill in" section frames this explicitly: replicate the macro's
  keystroke sequence "but via UIA `Invoke`/`SetValue` patterns on the
  actual controls instead of blind keystrokes wherever the controls
  support it — more robust than SendKeys-style automation." This was a
  deliberate choice, not a drift from the macro's intent, and is why
  Alt+O / the trailing `"w"` keystroke above aren't reproduced literally.
- **Priority dialog is SET, not ESC'd** — an earlier round (before
  2026-09-13) treated it like the other two dialogs and ESC'd past it,
  which was wrong; the current select-and-verify behavior is correct per
  Will's brief and is explicitly preserved this round.

## Known gaps (not attempted this round — no live target to verify against)

- Administration site (left/right arm) is never typed into PioneerRx —
  no signature field confirmed in any live dump.
- Medicare home-visit reason prompt has no UI at all.
- `InputDirectionsStep`'s `uxDirections` AutomationId is unconfirmed.
- The Priority/Scan Hard Copy/Patient on Cycle Fill dialogs' exact
  control shapes are unconfirmed (Priority's selection strategy was
  built defensively — try several UIA shapes — for exactly this reason).

Confirming any of the above needs a **live UIA tree dump** from the
pharmacy's own machine at the moment each screen/dialog is showing (the
in-app "Dump Pioneer UIA tree" button — see `Uia/UiaTreeDumper.cs`) —
none of this can be verified from a dev machine with no PioneerRx
install.
