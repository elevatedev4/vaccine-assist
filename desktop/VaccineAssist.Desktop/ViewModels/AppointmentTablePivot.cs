using System.Collections.Generic;
using System.Linq;
using VaccineAssist.Desktop.Models;

namespace VaccineAssist.Desktop.ViewModels;

/// <summary>
/// Pure transpose helper for the Scheduling tab: the cloud's
/// AppointmentTable is vaccine-rows x day-columns (one row per vaccine,
/// with a per-day count and a 7-day total), but the WPF DataGrid needs
/// day-rows x vaccine-columns (day is the row key, vaccine name is a
/// dynamically generated column — see SchedulingView.xaml.cs) plus a
/// trailing 7-day-sum row. No WPF/UI dependency — plain C# over the
/// Models types, so it's unit-testable without a live runtime.
/// </summary>
public static class AppointmentTablePivot
{
    public const string SummaryRowLabel = "7-day total";

    /// <summary>One ScheduleDisplayRow per table.Days entry, in the same
    /// order — does NOT include the summary row (see BuildSummaryRow).</summary>
    public static IReadOnlyList<ScheduleDisplayRow> Pivot(AppointmentTable table)
    {
        var displayRows = new List<ScheduleDisplayRow>(table.Days.Count);
        foreach (var day in table.Days)
        {
            var countsByVaccine = new Dictionary<string, int>();
            foreach (var vaccineRow in table.Rows)
            {
                countsByVaccine[vaccineRow.VaccineName] =
                    vaccineRow.CountsByDay.TryGetValue(day, out var count) ? count : 0;
            }

            var dailyTotal = table.DailyTotals.TryGetValue(day, out var total) ? total : 0;
            displayRows.Add(new ScheduleDisplayRow(day, countsByVaccine, dailyTotal));
        }

        return displayRows;
    }

    /// <summary>The trailing 7-day-sum row: one column per vaccine (its
    /// AppointmentTableRow.Total) plus the overall GrandTotal.</summary>
    public static ScheduleDisplayRow BuildSummaryRow(AppointmentTable table)
    {
        var totalsByVaccine = table.Rows.ToDictionary(r => r.VaccineName, r => r.Total);
        return new ScheduleDisplayRow(SummaryRowLabel, totalsByVaccine, table.GrandTotal);
    }
}
