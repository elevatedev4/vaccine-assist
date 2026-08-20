using System;
using VaccineAssist.Desktop.Common;
using VaccineAssist.Desktop.Models;

namespace VaccineAssist.Desktop.ViewModels;

/// <summary>
/// One row in the Active vaccines tab's DataGrid. Wraps a Vaccine so the
/// "Active" column's DataGridCheckBoxColumn can be genuinely two-way
/// bound and persisted — the shared Vaccine model itself has no
/// INotifyPropertyChanged (it's a plain POCO also used read-only by
/// LotsViewModel/DataEntryPopupViewModel), so this wrapper exists just
/// for this one editable screen rather than adding change-notification
/// machinery to a model those other screens don't need it on.
///
/// Toggling Active raises ActiveToggleRequested; VaccinesViewModel
/// subscribes and does the actual API call, calling RevertActive if the
/// PATCH fails so the UI never drifts silently out of sync with the
/// server.
/// </summary>
public sealed class VaccineRowViewModel : ObservableObject
{
    private bool _active;
    private bool _suppressPersist;

    public VaccineRowViewModel(Vaccine vaccine)
    {
        Id = vaccine.Id;
        Name = vaccine.Name;
        ShortCode = vaccine.ShortCode;
        Dose = vaccine.Dose;
        Ndc = vaccine.Ndc;
        CashPriceDisplay = vaccine.CashPriceDisplay;
        HasActiveLot = vaccine.HasActiveLot;
        _active = vaccine.Active;
    }

    public Guid Id { get; }
    public string Name { get; }
    public string ShortCode { get; }
    public string? Dose { get; }
    public string? Ndc { get; }
    public string CashPriceDisplay { get; }

    /// <summary>Read-only in the UI — whether `lot` has a current
    /// (status='active') row for this vaccine.</summary>
    public bool HasActiveLot { get; }

    public bool Active
    {
        get => _active;
        set
        {
            if (_active == value) return;
            SetProperty(ref _active, value);
            if (!_suppressPersist)
            {
                ActiveToggleRequested?.Invoke(this, value);
            }
        }
    }

    /// <summary>Sets Active back to its pre-toggle value after a failed
    /// persist, without re-raising ActiveToggleRequested (which would
    /// otherwise attempt to persist the revert itself and loop).</summary>
    public void RevertActive(bool previousValue)
    {
        _suppressPersist = true;
        Active = previousValue;
        _suppressPersist = false;
    }

    /// <summary>Raised when the user toggles the checkbox — the bool is
    /// the newly-requested value (already applied locally by the time
    /// this fires; the subscriber's job is only to persist it, or call
    /// RevertActive if that fails).</summary>
    public event Action<VaccineRowViewModel, bool>? ActiveToggleRequested;
}
