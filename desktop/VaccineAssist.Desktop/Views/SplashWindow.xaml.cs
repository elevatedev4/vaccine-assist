using System.Windows;

namespace VaccineAssist.Desktop.Views;

/// <summary>Tiny borderless "Signing in…" placeholder shown during the
/// silent sign-in attempt at startup — see App.xaml.cs's
/// StartSignInFlowAsync and this window's XAML doc comment.</summary>
public partial class SplashWindow : Window
{
    public SplashWindow()
    {
        InitializeComponent();
    }
}
