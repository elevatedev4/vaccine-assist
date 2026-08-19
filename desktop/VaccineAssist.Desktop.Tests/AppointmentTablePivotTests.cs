using System.Collections.Generic;
using VaccineAssist.Desktop.Models;
using VaccineAssist.Desktop.ViewModels;
using Xunit;

namespace VaccineAssist.Desktop.Tests;

/// <summary>
/// Unit tests for AppointmentTablePivot — the pure transpose the
/// Scheduling tab uses to turn the cloud's vaccine-rows/day-columns
/// AppointmentTable into day-rows/vaccine-columns for the WPF DataGrid
/// (see SchedulingViewModel/SchedulingView.xaml.cs). No WPF dependency,
/// so this is fully testable without a live runtime.
/// </summary>
public class AppointmentTablePivotTests
{
    private static AppointmentTable SampleTable() => new()
    {
        Days = new List<string> { "2026-08-19", "2026-08-20", "2026-08-21" },
        Rows = new List<AppointmentTableRow>
        {
            new()
            {
                VaccineName = "Flu",
                CountsByDay = new Dictionary<string, int> { ["2026-08-19"] = 2, ["2026-08-20"] = 0, ["2026-08-21"] = 5 },
                Total = 7,
            },
            new()
            {
                VaccineName = "COVID-Pfizer",
                CountsByDay = new Dictionary<string, int> { ["2026-08-19"] = 1, ["2026-08-21"] = 3 },
                Total = 4,
            },
        },
        DailyTotals = new Dictionary<string, int> { ["2026-08-19"] = 3, ["2026-08-20"] = 0, ["2026-08-21"] = 8 },
        GrandTotal = 11,
    };

    [Fact]
    public void PivotProducesOneDisplayRowPerDayInOrder()
    {
        var rows = AppointmentTablePivot.Pivot(SampleTable());

        Assert.Equal(3, rows.Count);
        Assert.Equal("2026-08-19", rows[0].Day);
        Assert.Equal("2026-08-20", rows[1].Day);
        Assert.Equal("2026-08-21", rows[2].Day);
    }

    [Fact]
    public void PivotTransposesEachVaccinesCountsByDayIntoPerDayColumns()
    {
        var rows = AppointmentTablePivot.Pivot(SampleTable());

        Assert.Equal(2, rows[0].CountsByVaccine["Flu"]);
        Assert.Equal(1, rows[0].CountsByVaccine["COVID-Pfizer"]);

        Assert.Equal(0, rows[1].CountsByVaccine["Flu"]);
        Assert.Equal(0, rows[1].CountsByVaccine["COVID-Pfizer"]); // missing entry in source -> defaults to 0

        Assert.Equal(5, rows[2].CountsByVaccine["Flu"]);
        Assert.Equal(3, rows[2].CountsByVaccine["COVID-Pfizer"]);
    }

    [Fact]
    public void PivotCarriesDailyTotalsOntoEachRow()
    {
        var rows = AppointmentTablePivot.Pivot(SampleTable());

        Assert.Equal(3, rows[0].Total);
        Assert.Equal(0, rows[1].Total);
        Assert.Equal(8, rows[2].Total);
    }

    [Fact]
    public void BuildSummaryRowUsesPerVaccineTotalsAndGrandTotal()
    {
        var summary = AppointmentTablePivot.BuildSummaryRow(SampleTable());

        Assert.Equal(AppointmentTablePivot.SummaryRowLabel, summary.Day);
        Assert.Equal(7, summary.CountsByVaccine["Flu"]);
        Assert.Equal(4, summary.CountsByVaccine["COVID-Pfizer"]);
        Assert.Equal(11, summary.Total);
    }

    [Fact]
    public void PivotOfAnEmptyTableProducesNoRows()
    {
        var table = new AppointmentTable
        {
            Days = new List<string>(),
            Rows = new List<AppointmentTableRow>(),
            DailyTotals = new Dictionary<string, int>(),
            GrandTotal = 0,
        };

        var rows = AppointmentTablePivot.Pivot(table);

        Assert.Empty(rows);
    }
}
