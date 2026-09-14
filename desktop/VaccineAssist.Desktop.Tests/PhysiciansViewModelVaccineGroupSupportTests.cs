using System;
using System.Linq;
using System.Threading.Tasks;
using VaccineAssist.Desktop.Models;
using VaccineAssist.Desktop.ViewModels;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// BLOCKING SAFETY FIX (reviewer, 2026-09-07 request-changes round): the
/// "All &lt;group&gt; vaccines" ComboBox option must be HIDDEN unless the
/// server (GET /api/physician-rules's own `vaccineGroupSupported` flag —
/// see the parallel feat/cloud-tabs branch's migration 0009) actually
/// supports physician_rule.vaccine_group. Otherwise a group rule "saved"
/// pre-migration persists as vaccine_id=null — an unrestricted "any
/// vaccine" wildcard rule, a silent over-grant of prescriber authority.
/// See PhysiciansViewModel.VaccineGroupSupported's own doc comment.
/// </summary>
public class PhysiciansViewModelVaccineGroupSupportTests
{
    private static PhysiciansViewModel CreateViewModel(out FakeVaccineApiService apiService)
    {
        apiService = new FakeVaccineApiService();
        return new PhysiciansViewModel(apiService);
    }

    [Fact]
    public void VaccineGroupSupportedDefaultsToFalseBeforeAnyLoad()
    {
        // Fail CLOSED before the first successful load, not open — a
        // fresh/not-yet-loaded tab must never show group options even
        // fleetingly.
        var viewModel = CreateViewModel(out _);

        Assert.False(viewModel.VaccineGroupSupported);
    }

    [Fact]
    public async Task WhenServerSupportsGroupsTheAllGroupOptionsAppearAndTheNoteIsHidden()
    {
        var viewModel = CreateViewModel(out var apiService);
        apiService.VaccineGroupSupported = true;
        apiService.Vaccines.Add(new Vaccine { Id = Guid.NewGuid(), Name = "Comirnaty 2025-26 12+", ShortCode = "comirnaty" });

        await viewModel.LoadAsync();

        Assert.True(viewModel.VaccineGroupSupported);
        Assert.Contains(viewModel.VaccineOptions, o => o.Group == "COVID vaccines" && o.IsGroupWildcard);
    }

    [Fact]
    public async Task WhenServerDoesNotSupportGroupsTheAllGroupOptionsAreOmittedEntirely()
    {
        var viewModel = CreateViewModel(out var apiService);
        apiService.VaccineGroupSupported = false;
        apiService.Vaccines.Add(new Vaccine { Id = Guid.NewGuid(), Name = "Comirnaty 2025-26 12+", ShortCode = "comirnaty" });
        apiService.Vaccines.Add(new Vaccine { Id = Guid.NewGuid(), Name = "Boostrix", ShortCode = "boostrix" });

        await viewModel.LoadAsync();

        Assert.False(viewModel.VaccineGroupSupported);
        Assert.DoesNotContain(viewModel.VaccineOptions, o => o.IsGroupWildcard);
        // Specific vaccines must still be selectable — only the group
        // ("All ... vaccines") option is gated, not the whole feature.
        Assert.Contains(viewModel.VaccineOptions, o => o.Group == "COVID vaccines" && o.DisplayText == "Comirnaty 2025-26 12+");
        // V-T21 item 7: Boostrix (fine-grained "Tetanus/whooping cough")
        // buckets into the physicians-tab catch-all "Other vaccines".
        Assert.Contains(viewModel.VaccineOptions, o => o.Group == "Other vaccines" && o.DisplayText == "Boostrix");
    }

    [Fact]
    public void UnsupportedFlagBlocksAddRuleEvenIfAStaleGroupOptionIsSomehowSelected()
    {
        // Belt-and-suspenders: simulate a stale selection (e.g. picked
        // right before a reload flipped the flag) reaching AddRuleAsync
        // directly, bypassing whatever BuildVaccineOptions would normally
        // offer.
        //
        // TEST FIX (2026-09-14, follow-up to the CI dispatcher fix below):
        // CI caught a real gap in this test's OWN setup, not in the
        // ViewModel — PhysiciansViewModel.VaccineGroupSupported is only
        // ever updated inside LoadAsync (see that method), so simply
        // mutating apiService.VaccineGroupSupported never changes what
        // THIS view model instance thinks. Without a second LoadAsync
        // call, the guard inside AddRuleAsync (`if (!VaccineGroupSupported)`)
        // was correctly reading its own still-true cached copy and let the
        // rule through — CI's "Collection was not empty" failure, not a
        // production bug: AddRuleAsync's guard behaved exactly as
        // written. The doc comment on AddRuleAsync's check is explicit
        // that the scenario it defends is a stale NewRuleVaccineOption
        // "selected just before a reload flips it" — i.e. a reload DOES
        // happen on this instance (correctly flipping VaccineGroupSupported
        // and rebuilding VaccineOptions without the wildcard) but nothing
        // clears the ComboBox-bound NewRuleVaccineOption, which keeps
        // pointing at the now-removed wildcard object. The added
        // viewModel.LoadAsync() below reproduces that: a real reload,
        // after which the pre-reload staleGroupOption reference is
        // deliberately re-selected to simulate the dangling binding.
        //
        // CI FIX (2026-09-14): AddRuleCommand is an AsyncRelayCommand,
        // whose Execute calls RaiseCanExecuteChanged() —
        // CommandManager.InvalidateRequerySuggested() under the hood —
        // which marshals onto the calling thread's Dispatcher via a
        // Background-priority BeginInvoke rather than running inline (see
        // RelayCommandRequeryTests.cs). xunit's default MTA thread-pool
        // threads have no Dispatcher pumping that queue, so this failed on
        // GitHub Actions' windows-latest runner even though the actual
        // ErrorMessage/PhysicianRuleRows assertions below don't depend on
        // that notification firing — the test now runs the whole body on
        // a dedicated, actively-pumped STA thread (StaTestRunner.RunStaAsync)
        // so nothing queued mid-test is silently dropped.
        StaTestRunner.RunStaAsync(async () =>
        {
            var viewModel = CreateViewModel(out var apiService);
            apiService.VaccineGroupSupported = true;
            apiService.Vaccines.Add(new Vaccine { Id = Guid.NewGuid(), Name = "Comirnaty 2025-26 12+", ShortCode = "comirnaty" });
            var physician = new Physician { Id = Guid.NewGuid(), DisplayName = "Kim, David", AlternateId = "ALTSECOND" };
            apiService.PhysicianRows.Add(physician);
            await viewModel.LoadAsync();

            var staleGroupOption = viewModel.VaccineOptions.Single(o => o.Group == "COVID vaccines" && o.IsGroupWildcard);

            // Flag flips false and THIS view model reloads (e.g. Will hits
            // Reload right after the migration gets rolled back) — a real
            // LoadAsync, so VaccineGroupSupported correctly becomes false
            // and BuildVaccineOptions rebuilds VaccineOptions without the
            // wildcard option. Nothing clears NewRuleVaccineOption though
            // (same as WPF's ComboBox not resetting SelectedItem just
            // because the bound collection changed), so re-selecting the
            // pre-reload staleGroupOption reference reproduces exactly the
            // dangling-selection race AddRuleAsync's hard stop defends
            // against.
            apiService.VaccineGroupSupported = false;
            await viewModel.LoadAsync();
            viewModel.NewRulePhysician = viewModel.Physicians.Single();
            viewModel.NewRuleVaccineOption = staleGroupOption;

            // CanExecute doesn't re-check the live flag (it's cheap/local,
            // same as every other CanExecute here) — the hard stop is inside
            // AddRuleAsync itself, exercised via Execute.
            viewModel.AddRuleCommand.Execute(null);
            await Task.Delay(20);

            Assert.Empty(apiService.PhysicianRuleRows);
            Assert.Contains("migration hasn't run", viewModel.ErrorMessage);
        });
    }

    [Fact]
    public async Task ReloadingAfterTheMigrationLandsRevealsTheGroupOptions()
    {
        var viewModel = CreateViewModel(out var apiService);
        apiService.VaccineGroupSupported = false;
        apiService.Vaccines.Add(new Vaccine { Id = Guid.NewGuid(), Name = "Comirnaty 2025-26 12+", ShortCode = "comirnaty" });
        await viewModel.LoadAsync();
        Assert.DoesNotContain(viewModel.VaccineOptions, o => o.IsGroupWildcard);

        apiService.VaccineGroupSupported = true; // migration lands
        await viewModel.LoadAsync();

        Assert.True(viewModel.VaccineGroupSupported);
        Assert.Contains(viewModel.VaccineOptions, o => o.Group == "COVID vaccines" && o.IsGroupWildcard);
    }
}
