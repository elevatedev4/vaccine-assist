using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace VaccineAssist.Desktop.Models;

/// <summary>
/// Mirrors cloud/lib/appointment-table.ts's AppointmentTable — the shape
/// cloud/app/api/acuity/poll/route.ts's `table` field returns (see that
/// route's RESPONSE CONTRACT doc comment). Rows are vaccine-keyed here
/// (one row per vaccine, one column per day); the Scheduling tab pivots
/// this to day-keyed display rows for the WPF DataGrid — see
/// ViewModels/AppointmentTablePivot.cs.
/// </summary>
public sealed class AppointmentTable
{
    [JsonPropertyName("days")]
    public List<string> Days { get; set; } = new();

    [JsonPropertyName("rows")]
    public List<AppointmentTableRow> Rows { get; set; } = new();

    [JsonPropertyName("dailyTotals")]
    public Dictionary<string, int> DailyTotals { get; set; } = new();

    [JsonPropertyName("grandTotal")]
    public int GrandTotal { get; set; }
}

public sealed class AppointmentTableRow
{
    [JsonPropertyName("vaccineName")]
    public string VaccineName { get; set; } = "";

    [JsonPropertyName("countsByDay")]
    public Dictionary<string, int> CountsByDay { get; set; } = new();

    [JsonPropertyName("total")]
    public int Total { get; set; }
}
