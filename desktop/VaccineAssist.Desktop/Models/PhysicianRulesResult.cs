using System.Collections.Generic;

namespace VaccineAssist.Desktop.Models;

/// <summary>
/// IVaccineApiService.GetPhysicianRulesAsync's result — the rules
/// themselves plus whether the server currently supports
/// physician_rule.vaccine_group (reviewer fix, 2026-09-07 request-changes
/// round). A parallel migration/cloud branch (feat/cloud-tabs) added GET
/// /api/physician-rules's own `vaccineGroupSupported` flag for exactly
/// this reason: a database that hasn't run migration 0009 yet has no
/// vaccine_group column at all, so a rule saved with only a GROUP intent
/// would silently persist as vaccine_id=null/vaccine_group=null — an
/// UNRESTRICTED "any vaccine" wildcard rule, i.e. a silent over-grant of
/// prescriber authority. PhysiciansViewModel.VaccineGroupSupported (set
/// from this) gates BuildVaccineOptions entirely: every "All &lt;group&gt;
/// vaccines" option is omitted outright when this is false.
/// </summary>
public sealed record PhysicianRulesResult(IReadOnlyList<PhysicianRule> PhysicianRules, bool VaccineGroupSupported);
