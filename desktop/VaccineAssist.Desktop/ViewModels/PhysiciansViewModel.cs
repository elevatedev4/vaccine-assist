using System;
using System.Collections.ObjectModel;
using System.Globalization;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Input;
using VaccineAssist.Desktop.Common;
using VaccineAssist.Desktop.Models;
using VaccineAssist.Desktop.Services;

namespace VaccineAssist.Desktop.ViewModels;

/// <summary>
/// Backs the Physicians settings tab (Will, 2026-09-05: "the user store
/// the physicians name and alternate ID in our app... then need a way to
/// assign which vaccines/age ranges apply which doctor"). Two lists:
/// physicians themselves (display name + Pioneer alternate ID), and rules
/// mapping a vaccine (or "any vaccine" — the wildcard/"everything else"
/// fallback, see cloud/lib/physician-resolution.ts) + age range to one of
/// them. DataEntryPopupViewModel.BuildLivePayloadAsync resolves against
/// these same rows (via IVaccineApiService.ResolvePhysicianAsync) at
/// entry time and blocks with a message pointing back at this tab when
/// nothing matches.
/// </summary>
public sealed class PhysiciansViewModel : ObservableObject
{
    private readonly IVaccineApiService _apiService;

    private bool _isBusy;
    private string? _errorMessage;
    private string _newPhysicianDisplayName = "";
    private string _newPhysicianAlternateId = "";
    private Physician? _newRulePhysician;
    private Vaccine? _newRuleVaccine;
    private bool _newRuleIsAnyVaccine;
    private string _newRuleMinAgeText = "";
    private string _newRuleMaxAgeText = "";
    private string _newRulePriorityText = "0";

    public PhysiciansViewModel(IVaccineApiService apiService)
    {
        _apiService = apiService;
        LoadCommand = new AsyncRelayCommand(LoadAsync, () => !IsBusy);
        AddPhysicianCommand = new AsyncRelayCommand(AddPhysicianAsync,
            () => !IsBusy && !string.IsNullOrWhiteSpace(NewPhysicianDisplayName) && !string.IsNullOrWhiteSpace(NewPhysicianAlternateId));
        DeletePhysicianCommand = new AsyncRelayCommand<Physician>(DeletePhysicianAsync, _ => !IsBusy);
        AddRuleCommand = new AsyncRelayCommand(AddRuleAsync,
            () => !IsBusy && NewRulePhysician is not null && (NewRuleIsAnyVaccine || NewRuleVaccine is not null));
        DeleteRuleCommand = new AsyncRelayCommand<PhysicianRule>(DeleteRuleAsync, _ => !IsBusy);
    }

    public ObservableCollection<Physician> Physicians { get; } = new();
    public ObservableCollection<PhysicianRule> PhysicianRules { get; } = new();
    public ObservableCollection<Vaccine> Vaccines { get; } = new();

    public bool IsBusy
    {
        get => _isBusy;
        private set => SetProperty(ref _isBusy, value);
    }

    public string? ErrorMessage
    {
        get => _errorMessage;
        private set => SetProperty(ref _errorMessage, value);
    }

    public string NewPhysicianDisplayName
    {
        get => _newPhysicianDisplayName;
        set => SetProperty(ref _newPhysicianDisplayName, value);
    }

    /// <summary>See the Physicians tab's info-icon tooltip: add one in
    /// Pioneer via Prescriber profile &gt; Alternate ID &gt; an ID of the
    /// pharmacy's own choosing, no spaces.</summary>
    public string NewPhysicianAlternateId
    {
        get => _newPhysicianAlternateId;
        set => SetProperty(ref _newPhysicianAlternateId, value);
    }

    public Physician? NewRulePhysician
    {
        get => _newRulePhysician;
        set => SetProperty(ref _newRulePhysician, value);
    }

    public Vaccine? NewRuleVaccine
    {
        get => _newRuleVaccine;
        set => SetProperty(ref _newRuleVaccine, value);
    }

    /// <summary>When true, the rule applies to any vaccine (the wildcard/
    /// "everything else" fallback — Will's own example: the protocol
    /// physician who covers everything the pharmacist's own PREP-act
    /// authority doesn't) — NewRuleVaccine is ignored in that case.</summary>
    public bool NewRuleIsAnyVaccine
    {
        get => _newRuleIsAnyVaccine;
        set => SetProperty(ref _newRuleIsAnyVaccine, value);
    }

    public string NewRuleMinAgeText
    {
        get => _newRuleMinAgeText;
        set => SetProperty(ref _newRuleMinAgeText, value);
    }

    public string NewRuleMaxAgeText
    {
        get => _newRuleMaxAgeText;
        set => SetProperty(ref _newRuleMaxAgeText, value);
    }

    public string NewRulePriorityText
    {
        get => _newRulePriorityText;
        set => SetProperty(ref _newRulePriorityText, value);
    }

    public ICommand LoadCommand { get; }
    public ICommand AddPhysicianCommand { get; }
    public ICommand DeletePhysicianCommand { get; }
    public ICommand AddRuleCommand { get; }
    public ICommand DeleteRuleCommand { get; }

    public async Task LoadAsync()
    {
        IsBusy = true;
        ErrorMessage = null;
        try
        {
            var physiciansTask = _apiService.GetPhysiciansAsync();
            var rulesTask = _apiService.GetPhysicianRulesAsync();
            var vaccinesTask = _apiService.GetVaccinesAsync();
            await Task.WhenAll(physiciansTask, rulesTask, vaccinesTask);

            Physicians.Clear();
            foreach (var physician in physiciansTask.Result) Physicians.Add(physician);

            PhysicianRules.Clear();
            foreach (var rule in rulesTask.Result) PhysicianRules.Add(rule);

            Vaccines.Clear();
            foreach (var vaccine in vaccinesTask.Result.OrderBy(v => v.Name)) Vaccines.Add(vaccine);
        }
        catch (Exception ex)
        {
            ErrorMessage = $"Couldn't load physicians: {ex.Message}";
        }
        finally
        {
            IsBusy = false;
        }
    }

    private async Task AddPhysicianAsync()
    {
        if (string.IsNullOrWhiteSpace(NewPhysicianDisplayName) || string.IsNullOrWhiteSpace(NewPhysicianAlternateId)) return;

        if (NewPhysicianAlternateId.Any(char.IsWhiteSpace))
        {
            ErrorMessage = "Alternate ID must not contain spaces (Pioneer's own Alternate ID rule).";
            return;
        }

        IsBusy = true;
        ErrorMessage = null;
        try
        {
            var created = await _apiService.CreatePhysicianAsync(NewPhysicianDisplayName.Trim(), NewPhysicianAlternateId.Trim());
            Physicians.Add(created);
            NewPhysicianDisplayName = "";
            NewPhysicianAlternateId = "";
        }
        catch (Exception ex)
        {
            ErrorMessage = $"Couldn't add physician: {ex.Message}";
        }
        finally
        {
            IsBusy = false;
        }
    }

    private async Task DeletePhysicianAsync(Physician? physician)
    {
        if (physician is null) return;

        IsBusy = true;
        ErrorMessage = null;
        try
        {
            await _apiService.DeletePhysicianAsync(physician.Id);
            Physicians.Remove(physician);
            // physician_rule rows referencing this physician cascade-delete
            // in Supabase (see supabase/migrations/0007_physicians.sql) —
            // reload rules so the local list doesn't show orphans.
            await LoadAsync();
        }
        catch (Exception ex)
        {
            ErrorMessage = $"Couldn't delete physician: {ex.Message}";
        }
        finally
        {
            IsBusy = false;
        }
    }

    private async Task AddRuleAsync()
    {
        if (NewRulePhysician is null || (!NewRuleIsAnyVaccine && NewRuleVaccine is null)) return;

        int? minAge = null;
        if (!string.IsNullOrWhiteSpace(NewRuleMinAgeText))
        {
            if (!int.TryParse(NewRuleMinAgeText, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsedMin))
            {
                ErrorMessage = "Min age must be a whole number.";
                return;
            }
            minAge = parsedMin;
        }

        int? maxAge = null;
        if (!string.IsNullOrWhiteSpace(NewRuleMaxAgeText))
        {
            if (!int.TryParse(NewRuleMaxAgeText, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsedMax))
            {
                ErrorMessage = "Max age must be a whole number.";
                return;
            }
            maxAge = parsedMax;
        }

        if (minAge is int minVal && maxAge is int maxVal && minVal > maxVal)
        {
            ErrorMessage = "Min age must not be greater than max age.";
            return;
        }

        var priority = 0;
        if (!string.IsNullOrWhiteSpace(NewRulePriorityText) &&
            !int.TryParse(NewRulePriorityText, NumberStyles.Integer, CultureInfo.InvariantCulture, out priority))
        {
            ErrorMessage = "Priority must be a whole number.";
            return;
        }

        IsBusy = true;
        ErrorMessage = null;
        try
        {
            var vaccineId = NewRuleIsAnyVaccine ? (Guid?)null : NewRuleVaccine!.Id;
            var created = await _apiService.CreatePhysicianRuleAsync(NewRulePhysician.Id, vaccineId, minAge, maxAge, priority);
            PhysicianRules.Add(created);
            NewRuleMinAgeText = "";
            NewRuleMaxAgeText = "";
            NewRulePriorityText = "0";
        }
        catch (Exception ex)
        {
            ErrorMessage = $"Couldn't add rule: {ex.Message}";
        }
        finally
        {
            IsBusy = false;
        }
    }

    private async Task DeleteRuleAsync(PhysicianRule? rule)
    {
        if (rule is null) return;

        IsBusy = true;
        ErrorMessage = null;
        try
        {
            await _apiService.DeletePhysicianRuleAsync(rule.Id);
            PhysicianRules.Remove(rule);
        }
        catch (Exception ex)
        {
            ErrorMessage = $"Couldn't delete rule: {ex.Message}";
        }
        finally
        {
            IsBusy = false;
        }
    }

    /// <summary>Display helper for the rules grid — "Any vaccine" for a
    /// wildcard rule, otherwise the vaccine's name (looked up from the
    /// already-loaded Vaccines list; PhysicianRule itself only carries the
    /// id).</summary>
    public string VaccineDisplayNameFor(PhysicianRule rule) =>
        rule.VaccineId is null
            ? "Any vaccine"
            : Vaccines.FirstOrDefault(v => v.Id == rule.VaccineId)?.Name ?? "(unknown vaccine)";

    /// <summary>Display helper for the rules grid.</summary>
    public string PhysicianDisplayNameFor(PhysicianRule rule) =>
        Physicians.FirstOrDefault(p => p.Id == rule.PhysicianId)?.DisplayName ?? "(unknown physician)";
}
