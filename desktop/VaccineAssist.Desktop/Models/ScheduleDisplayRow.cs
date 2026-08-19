using System.Collections.Generic;

namespace VaccineAssist.Desktop.Models;

/// <summary>
/// One row of the Scheduling tab's DataGrid, after pivoting the cloud's
/// vaccine-rows/day-columns AppointmentTable into day-rows/vaccine-columns
/// for display (see ViewModels/AppointmentTablePivot.cs). Also used for
/// the trailing 7-day-sum row (Day = AppointmentTablePivot.SummaryRowLabel).
/// </summary>
public sealed class ScheduleDisplayRow
{
    public ScheduleDisplayRow(string day, IReadOnlyDictionary<string, int> countsByVaccine, int total)
    {
        Day = day;
        CountsByVaccine = countsByVaccine;
        Total = total;
    }

    public string Day { get; }

    /// <summary>Keyed by vaccine name — read via VaccineCountConverter in
    /// SchedulingView's dynamically generated per-vaccine columns, since
    /// column count/names aren't known until the data loads.</summary>
    public IReadOnlyDictionary<string, int> CountsByVaccine { get; }

    public int Total { get; }
}
