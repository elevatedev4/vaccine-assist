using System;
using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Globalization;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Data;
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
    private PhysicianRuleVaccineOption? _newRuleVaccineOption;
    private bool _newRuleIsAnyVaccine;
    private string _newRuleMinAgeText = "";
    private string _newRuleMaxAgeText = "";
    private string _newRulePriorityText = "0";
    private readonly ICollectionView _vaccineOptionsView;

    public PhysiciansViewModel(IVaccineApiService apiService)
    {
        _apiService = apiService;
        LoadCommand = new AsyncRelayCommand(LoadAsync, () => !IsBusy);
        AddPhysicianCommand = new AsyncRelayCommand(AddPhysicianAsync,
            () => !IsBusy && !string.IsNullOrWhiteSpace(NewPhysicianDisplayName) && !string.IsNullOrWhiteSpace(NewPhysicianAlternateId));
        DeletePhysicianCommand = new AsyncRelayCommand<Physician>(DeletePhysicianAsync, _ => !IsBusy);
        AddRuleCommand = new AsyncRelayCommand(AddRuleAsync,
            () => !IsBusy && NewRulePhysician is not null && (NewRuleIsAnyVaccine || NewRuleVaccineOption is not null));
        DeleteRuleCommand = new AsyncRelayCommand<PhysicianRule>(DeleteRuleAsync, _ => !IsBusy);

        // Grouped ComboBox (Will, 2026-09-07: "vaccine types as group
        // headers... with an 'All <group> vaccines' selectable item per
        // group... and specific vaccines beneath") — WPF's native
        // GroupStyle grouping over VaccineOptions, rebuilt by
        // BuildVaccineOptions whenever Vaccines (re)loads. A
        // ListCollectionView over an ObservableCollection observes that
        // collection's own Clear()/Add() changes automatically, so no
        // manual Refresh() is needed after each rebuild — same
        // Clear()-then-Add() convention this class and
        // DataEntryPopupViewModel already use elsewhere.
        _vaccineOptionsView = CollectionViewSource.GetDefaultView(VaccineOptions);
        _vaccineOptionsView.GroupDescriptions.Add(new PropertyGroupDescription(nameof(PhysicianRuleVaccineOption.Group)));
    }

    public ObservableCollection<Physician> Physicians { get; } = new();
    public ObservableCollection<PhysicianRule> PhysicianRules { get; } = new();
    public ObservableCollection<Vaccine> Vaccines { get; } = new();
    public ObservableCollection<PhysicianRuleVaccineOption> VaccineOptions { get; } = new();

    /// <summary>Bound as the Physicians tab's "Vaccine" ComboBox's
    /// ItemsSource (Views/PhysiciansView.xaml) — VaccineOptions grouped by
    /// VaccineGroupCatalog group, rendered via GroupStyle. Exposed
    /// separately from VaccineOptions itself so the view gets grouping for
    /// free rather than needing its own CollectionViewSource resource.</summary>
    public ICollectionView VaccineOptionsView => _vaccineOptionsView;

    private bool _vaccineGroupSupported;

    /// <summary>
    /// BLOCKING SAFETY FIX (reviewer, 2026-09-07 request-changes round):
    /// whether the server currently supports physician_rule.vaccine_group
    /// (set from GetPhysicianRulesAsync's own PhysicianRulesResult — see
    /// that type's doc comment for the parallel migration/cloud-branch
    /// context). Defaults to FALSE — fail CLOSED — before the first
    /// successful LoadAsync, so the "All &lt;group&gt; vaccines" options
    /// never appear even fleetingly on a fresh, not-yet-loaded tab.
    /// BuildVaccineOptions omits every group option entirely while this is
    /// false; AddRuleAsync also re-checks it directly before sending a
    /// group (belt-and-suspenders, in case VaccineOptions ever goes stale
    /// relative to this flag). Bound in Views/PhysiciansView.xaml to show
    /// a short "pending migration" note when false.
    ///
    /// WHY THIS MATTERS: on a database that hasn't run migration 0009 yet
    /// (no vaccine_group column at all), a rule "saved" with only a GROUP
    /// intent silently persists as vaccine_id=null/vaccine_group=null —
    /// an UNRESTRICTED "any vaccine" wildcard rule. That's a silent
    /// over-grant of prescriber authority, not just a cosmetic gap.
    /// </summary>
    public bool VaccineGroupSupported
    {
        get => _vaccineGroupSupported;
        private set => SetProperty(ref _vaccineGroupSupported, value);
    }

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

    /// <summary>
    /// The Physicians tab's grouped "Vaccine" ComboBox selection — either a
    /// specific-vaccine option or an "All &lt;group&gt; vaccines" option
    /// (PhysicianRuleVaccineOption.IsGroupWildcard). See AddRuleAsync for
    /// how each shape maps onto PhysicianRule.VaccineId/VaccineGroup.
    /// </summary>
    public PhysicianRuleVaccineOption? NewRuleVaccineOption
    {
        get => _newRuleVaccineOption;
        set => SetProperty(ref _newRuleVaccineOption, value);
    }

    /// <summary>When true, the rule applies to any vaccine (the true
    /// wildcard/"everything else" fallback — Will's own example: the
    /// protocol physician who covers everything the pharmacist's own
    /// PREP-act authority doesn't) — NewRuleVaccineOption is ignored in
    /// that case. Distinct from picking "All &lt;group&gt; vaccines" in the
    /// ComboBox, which targets one specific VaccineGroupCatalog group
    /// rather than every vaccine.</summary>
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

            var rulesResult = rulesTask.Result;
            PhysicianRules.Clear();
            foreach (var rule in rulesResult.PhysicianRules) PhysicianRules.Add(rule);
            // MUST be set before BuildVaccineOptions() below reads it —
            // see VaccineGroupSupported's own doc comment.
            VaccineGroupSupported = rulesResult.VaccineGroupSupported;

            Vaccines.Clear();
            foreach (var vaccine in vaccinesTask.Result.OrderBy(v => v.Name)) Vaccines.Add(vaccine);
            BuildVaccineOptions();
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

    /// <summary>(Re)builds VaccineOptions from Vaccines — VaccineGroupCatalog.DisplayOrder
    /// order, one "All &lt;group&gt; vaccines" option first in each group
    /// present (ONLY when VaccineGroupSupported — see that property's own
    /// doc comment for why an unsupported server must never see this
    /// option at all, not even a disabled one), then that group's vaccines
    /// by name. Always Clear()s before re-Add()ing (same convention
    /// DataEntryPopupViewModel's BuildAvailableGroups/BuildProductOptions
    /// use) so VaccineOptionsView's grouping stays in sync with a fresh
    /// load. Callers MUST set VaccineGroupSupported before calling this —
    /// see LoadAsync.</summary>
    private void BuildVaccineOptions()
    {
        VaccineOptions.Clear();
        var byGroup = Vaccines
            .GroupBy(VaccineGroupCatalog.GetGroup)
            .ToDictionary(g => g.Key, g => g.OrderBy(v => v.Name).ToList());

        foreach (var group in VaccineGroupCatalog.DisplayOrder.Where(byGroup.ContainsKey))
        {
            if (VaccineGroupSupported)
            {
                VaccineOptions.Add(new PhysicianRuleVaccineOption { Group = group, DisplayText = $"All {group} vaccines" });
            }
            foreach (var vaccine in byGroup[group])
            {
                VaccineOptions.Add(new PhysicianRuleVaccineOption { Group = group, DisplayText = vaccine.Name, Vaccine = vaccine });
            }
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
        if (NewRulePhysician is null || (!NewRuleIsAnyVaccine && NewRuleVaccineOption is null)) return;

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

        Guid? vaccineId = null;
        string? vaccineGroup = null;
        if (!NewRuleIsAnyVaccine)
        {
            if (NewRuleVaccineOption!.IsGroupWildcard)
            {
                // Belt-and-suspenders (reviewer fix, 2026-09-07):
                // BuildVaccineOptions is supposed to never OFFER a group
                // option at all while VaccineGroupSupported is false, but
                // this is a hard stop in case NewRuleVaccineOption is ever
                // stale relative to that flag (e.g. selected just before a
                // reload flips it) — never silently send a group intent
                // the server can't persist as a group (see
                // VaccineGroupSupported's own doc comment for why that's
                // an unrestricted-wildcard safety issue, not just UX).
                if (!VaccineGroupSupported)
                {
                    ErrorMessage = "Vaccine-type rules aren't available yet — the migration hasn't run. Refresh and pick a specific vaccine instead.";
                    return;
                }
                vaccineGroup = NewRuleVaccineOption.Group;
            }
            else
            {
                vaccineId = NewRuleVaccineOption.Vaccine!.Id;
            }
        }

        IsBusy = true;
        ErrorMessage = null;
        try
        {
            var created = await _apiService.CreatePhysicianRuleAsync(NewRulePhysician.Id, vaccineId, minAge, maxAge, priority, vaccineGroup);
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
    /// true wildcard rule, "All &lt;group&gt; vaccines" for a group rule
    /// (2026-09-07), otherwise the vaccine's name (looked up from the
    /// already-loaded Vaccines list; PhysicianRule itself only carries the
    /// id).</summary>
    public string VaccineDisplayNameFor(PhysicianRule rule)
    {
        if (rule.VaccineId is Guid vaccineId)
        {
            return Vaccines.FirstOrDefault(v => v.Id == vaccineId)?.Name ?? "(unknown vaccine)";
        }
        return rule.VaccineGroup is string group ? $"All {group} vaccines" : "Any vaccine";
    }

    /// <summary>Display helper for the rules grid.</summary>
    public string PhysicianDisplayNameFor(PhysicianRule rule) =>
        Physicians.FirstOrDefault(p => p.Id == rule.PhysicianId)?.DisplayName ?? "(unknown physician)";
}
