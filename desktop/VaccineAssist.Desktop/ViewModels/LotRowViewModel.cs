using System;
using System.Collections.Generic;
using VaccineAssist.Desktop.Common;
using VaccineAssist.Desktop.Models;

namespace VaccineAssist.Desktop.ViewModels;

/// <summary>
/// One row in the Lots screen's editable DataGrid (MSG893 item 4: "Lots
/// screen becomes an editable table with autosave"). Wraps a Lot the same
/// way VaccineRowViewModel wraps a Vaccine for the Active vaccines tab's
/// editable Active column — see that class's own doc comment for why a
/// wrapper exists instead of adding INotifyPropertyChanged straight onto
/// the shared Lot model (a plain POCO also used read-only elsewhere).
/// Adds VaccineName/VaccineNdc (joined in by LotsViewModel from the
/// vaccine catalog — Lot itself only carries VaccineId).
///
/// LotNumber/Expiration/BeyondUseDate/Note are genuinely two-way bound
/// (DataGridTextColumn / a DatePicker column) and AUTOSAVE: each setter
/// raises EditCommitted once the value actually changes (matching
/// VaccineRowViewModel.Active's "commit on set" convention — a DataGrid
/// cell's binding only pushes the new value into the source property when
/// editing ends, i.e. exactly "commit on cell edit end").
///
/// RACE HANDLING: EditCommitted carries an incrementing token (bumped on
/// EVERY committed edit, not just the field that changed) so LotsViewModel
/// can tell whether the save it's about to apply the result of is still
/// the LATEST edit for this row. A stale FAILURE (an older edit's PATCH
/// failing after a newer edit has already superseded it) is simply
/// ignored — the newer edit's own in-flight PATCH already carries this
/// row's full, up-to-date field snapshot and will resolve the row's
/// visible state on its own completion.
///
/// REVIEWER FIX (Major, request-changes round): a stale SUCCESS is a
/// DIFFERENT case and must NOT be simply ignored the same way. Repro: two
/// overlapping edits (token 1 = "A", token 2 = "B"); token 2's PATCH
/// resolves FIRST and FAILS, reverting the visible fields to whatever was
/// committed before either edit; token 1's PATCH resolves SECOND and
/// SUCCEEDS. "A" genuinely persisted server-side, so the row's revert
/// target (_committed) MUST move to "A" — silently no-op'ing this success
/// (the old `token != _editToken` guard alone) left _committed stuck at
/// the pre-edit original forever, so a LATER failure would revert all the
/// way back past a value the server actually holds, and nothing ever
/// reconciled the drift short of a full reload. Fixed by tracking
/// _appliedToken (the highest token whose OWN captured snapshot has been
/// applied to _committed) separately from _editToken (the highest token
/// COMMITTED locally, regardless of whether it has resolved yet) — see
/// ApplySaveSuccess. Per-token snapshots are captured at RequestSave time
/// (_pendingSnapshotsByToken) specifically so a late success can still
/// commit the EXACT values that edit actually sent, not whatever the row
/// happens to display by the time the response arrives (which may since
/// have been reverted or re-edited).
/// </summary>
public sealed class LotRowViewModel : ObservableObject
{
    private bool _suppressPersist;
    private string _lotNumber;
    private DateTime _expiration;
    private DateTime? _beyondUseDate;
    private string? _note;
    private string? _saveError;
    private int _editToken;

    /// <summary>Highest token whose snapshot has actually been applied to
    /// _committed so far — guards against an even-OLDER stale success
    /// arriving later and regressing _committed backward past a newer
    /// one already applied. See class doc comment.</summary>
    private int _appliedToken;

    /// <summary>Snapshot captured at the moment each token's edit
    /// committed (RequestSave) — so ApplySaveSuccess can update _committed
    /// to what THAT specific save actually sent, even if arrives late and
    /// the row's live fields have since moved on. Pruned as tokens
    /// resolve (success or failure) so this never grows unbounded.</summary>
    private readonly Dictionary<int, (string LotNumber, DateTime Expiration, DateTime? BeyondUseDate, string? Note)> _pendingSnapshotsByToken = new();

    /// <summary>The last field snapshot known to have been saved
    /// successfully (or the lot's original loaded values, before any
    /// edit) — what a failed save reverts back to.</summary>
    private (string LotNumber, DateTime Expiration, DateTime? BeyondUseDate, string? Note) _committed;

    public LotRowViewModel(Lot lot, string vaccineName, string? vaccineNdc)
    {
        Id = lot.Id;
        VaccineId = lot.VaccineId;
        VaccineName = vaccineName;
        VaccineNdc = vaccineNdc;
        Status = lot.Status;

        _lotNumber = lot.LotNumber;
        _expiration = lot.Expiration.ToDateTime(TimeOnly.MinValue);
        _beyondUseDate = lot.BeyondUseDate?.ToDateTime(TimeOnly.MinValue);
        _note = lot.Note;
        _committed = (_lotNumber, _expiration, _beyondUseDate, _note);
    }

    public Guid Id { get; }
    public Guid VaccineId { get; }
    public string VaccineName { get; }
    public string? VaccineNdc { get; }

    /// <summary>Read-only in this grid — "active"/"depleted"; editing
    /// status isn't part of MSG893 item 4's ask.</summary>
    public string Status { get; }

    public string LotNumber
    {
        get => _lotNumber;
        set
        {
            if (SetProperty(ref _lotNumber, value)) RequestSave();
        }
    }

    /// <summary>Bound to a DatePicker column, not plain text — see
    /// LotsView.xaml. Raises IsExpired's change notification too, so the
    /// row-highlight DataTrigger (Views/LotsView.xaml's RowStyle) updates
    /// live the moment the date is edited, per the brief's "clears
    /// automatically once the date is edited to a future date."</summary>
    public DateTime Expiration
    {
        get => _expiration;
        set
        {
            if (SetProperty(ref _expiration, value))
            {
                OnPropertyChanged(nameof(IsExpired));
                RequestSave();
            }
        }
    }

    /// <summary>Nullable — DatePicker.SelectedDate is itself DateTime?,
    /// so no separate "has a BUD" flag is needed; clearing the date in
    /// the UI sets this to null, which UpdateLotAsync sends as an
    /// explicit clear (not "field omitted").</summary>
    public DateTime? BeyondUseDate
    {
        get => _beyondUseDate;
        set
        {
            if (SetProperty(ref _beyondUseDate, value))
            {
                OnPropertyChanged(nameof(IsPastBeyondUseDate));
                RequestSave();
            }
        }
    }

    public string? Note
    {
        get => _note;
        set
        {
            if (SetProperty(ref _note, value)) RequestSave();
        }
    }

    public bool IsExpired => _expiration.Date < DateTime.Today;

    public bool IsPastBeyondUseDate => _beyondUseDate is DateTime bud && bud.Date <= DateTime.Today;

    /// <summary>Null when nothing needs saying (no save ever failed, or
    /// the most recent one succeeded) — bound to an inline status column
    /// in Views/LotsView.xaml so a failure is never silent.</summary>
    public string? SaveError
    {
        get => _saveError;
        private set => SetProperty(ref _saveError, value);
    }

    /// <summary>Raised once per committed edit (see class doc comment for
    /// the race-handling contract). The int is this edit's token —
    /// LotsViewModel passes it back into ApplySaveSuccess/ApplySaveFailure
    /// so a stale response can't clobber a newer edit's outcome.</summary>
    public event Action<LotRowViewModel, int>? EditCommitted;

    private void RequestSave()
    {
        if (_suppressPersist) return;
        SaveError = null;
        var token = ++_editToken;
        _pendingSnapshotsByToken[token] = CurrentSnapshot();
        EditCommitted?.Invoke(this, token);
    }

    /// <summary>The field values LotsViewModel should PATCH with for this
    /// edit — captured at call time (right when EditCommitted fires), not
    /// read again later, so a save's request body reflects exactly what
    /// the user had entered at the moment it committed.</summary>
    public (string LotNumber, DateTime Expiration, DateTime? BeyondUseDate, string? Note) CurrentSnapshot() =>
        (_lotNumber, _expiration, _beyondUseDate, _note);

    /// <summary>
    /// Called by LotsViewModel once a PATCH succeeds. REVIEWER FIX: unlike
    /// ApplySaveFailure, this does NOT no-op just because a newer edit has
    /// since superseded this one — a stale success still means the SERVER
    /// genuinely holds these values now, so _committed (the revert target)
    /// must move forward to reflect that, using this token's OWN captured
    /// snapshot (_pendingSnapshotsByToken), not whatever the row currently
    /// displays. Guarded by _appliedToken (not _editToken) so an
    /// even-older success arriving later still can't regress _committed
    /// past a newer one already applied.
    ///
    /// Visible fields/SaveError are only touched when this success IS for
    /// the current edit (token == _editToken) — a stale success updating
    /// the invisible revert target is exactly the fix; forcibly overwriting
    /// what the user currently sees (which may already reflect a NEWER,
    /// still-unresolved edit) is a separate, larger UX question this fix
    /// deliberately does not take on.
    /// </summary>
    public void ApplySaveSuccess(int token)
    {
        if (token > _appliedToken && _pendingSnapshotsByToken.TryGetValue(token, out var savedSnapshot))
        {
            _appliedToken = token;
            _committed = savedSnapshot;
        }
        _pendingSnapshotsByToken.Remove(token);

        if (token == _editToken)
        {
            SaveError = null;
        }
    }

    /// <summary>Called by LotsViewModel once a PATCH fails. No-ops (other
    /// than pruning this token's pending snapshot) if a newer edit has
    /// since superseded this one — that newer edit's own save will resolve
    /// the row's visible state; otherwise reverts every editable field
    /// back to the last known-good (_committed) values and surfaces
    /// <paramref name="message"/> via SaveError.</summary>
    public void ApplySaveFailure(int token, string message)
    {
        _pendingSnapshotsByToken.Remove(token);
        if (token != _editToken) return;

        _suppressPersist = true;
        LotNumber = _committed.LotNumber;
        Expiration = _committed.Expiration;
        BeyondUseDate = _committed.BeyondUseDate;
        Note = _committed.Note;
        _suppressPersist = false;

        SaveError = message;
    }

    /// <summary>
    /// Lets the view surface a client-side validation problem that never
    /// goes through EditCommitted/autosave at all (MSG893 reviewer fix,
    /// Minor: a cleared Expiration DatePicker — see LotsView.xaml.cs's
    /// ExpirationDatePicker_OnSelectedDateChanged) — reuses the same
    /// SaveError column an actual failed PATCH uses, so no separate UI is
    /// needed for "this edit was rejected before it ever reached the
    /// server."
    /// </summary>
    public void ReportValidationError(string message) => SaveError = message;
}
