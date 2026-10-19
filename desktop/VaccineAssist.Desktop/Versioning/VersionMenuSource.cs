using System.Collections.Generic;

namespace VaccineAssist.Desktop.Versioning;

/// <summary>What the two native menus need to draw the "Version" submenu: the running build and the remote testing-branch catalog.</summary>
public sealed class VersionMenuSource
{
    public VersionMenuSource(BuildInfo current, TestingVersionCatalog catalog)
    {
        Current = current;
        Catalog = catalog;
    }

    public BuildInfo Current { get; }
    public TestingVersionCatalog Catalog { get; }

    public IReadOnlyList<VersionMenuItem> BuildItems() => VersionMenuBuilder.Build(Current, Catalog.Snapshot);
}
