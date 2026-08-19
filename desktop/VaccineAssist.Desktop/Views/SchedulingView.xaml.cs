using System.Windows;
using System.Windows.Controls;
using System.Windows.Data;
using VaccineAssist.Desktop.Common;
using VaccineAssist.Desktop.Models;
using VaccineAssist.Desktop.ViewModels;

namespace VaccineAssist.Desktop.Views;

/// <summary>
/// The Scheduling tab. Its DataGrid columns aren't fixed — one column per
/// unique vaccine name coming back from the cloud API, which isn't known
/// until the data loads — so AutoGenerateColumns is off and columns are
/// rebuilt in code-behind whenever SchedulingViewModel.VaccineNames
/// changes, rather than being declared in XAML.
/// </summary>
public partial class SchedulingView : UserControl
{
    private static readonly VaccineCountConverter CountConverter = new();

    private readonly SchedulingViewModel _viewModel;

    public SchedulingView(SchedulingViewModel viewModel)
    {
        InitializeComponent();
        _viewModel = viewModel;
        DataContext = _viewModel;
        _viewModel.VaccineNames.CollectionChanged += (_, _) => RebuildColumns();
    }

    private async void SchedulingView_OnLoaded(object sender, RoutedEventArgs e)
    {
        await _viewModel.LoadAsync();
    }

    private void RebuildColumns()
    {
        ScheduleGrid.Columns.Clear();

        ScheduleGrid.Columns.Add(new DataGridTextColumn
        {
            Header = "Day",
            Binding = new Binding(nameof(ScheduleDisplayRow.Day)),
            Width = 110,
        });

        foreach (var vaccineName in _viewModel.VaccineNames)
        {
            ScheduleGrid.Columns.Add(new DataGridTextColumn
            {
                Header = vaccineName,
                Binding = new Binding(nameof(ScheduleDisplayRow.CountsByVaccine))
                {
                    Converter = CountConverter,
                    ConverterParameter = vaccineName,
                },
                Width = 90,
            });
        }

        ScheduleGrid.Columns.Add(new DataGridTextColumn
        {
            Header = "Daily total",
            Binding = new Binding(nameof(ScheduleDisplayRow.Total)),
            Width = 100,
        });
    }
}
