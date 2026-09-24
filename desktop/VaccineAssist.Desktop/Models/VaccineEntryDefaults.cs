namespace VaccineAssist.Desktop.Models;

/// <summary>
/// V-T41 (Will's 2026-09-22 brief, item 3, verbatim): "Quantity/
/// directions: never skip silently — if Models.Vaccine has no quantity/
/// directions, use the macro's defaults for that vaccine type... and log
/// what was typed." Pure resolution logic — given a Vaccine row (its own
/// Quantity/Directions, plus the cloud-computed QuantityDefault/
/// DirectionsDefault GET /api/vaccines and GET /api/eligibility/for-age
/// both add via cloud/lib/entry-defaults.ts — see Vaccine.cs's own doc
/// comments on all four properties), decides what value actually reaches
/// PioneerRx. A dependency-free static class (no HTTP/UIA) so it's
/// directly unit-testable — see VaccineEntryDefaultsTests.cs — same "pure
/// logic split out for testability" pattern as
/// InputLotAndExpirationStep.ToPioneerDateFormat.
/// </summary>
public static class VaccineEntryDefaults
{
    /// <summary>The value that should be typed into PioneerRx (or null if
    /// there's genuinely nothing — no per-vaccine value AND no catalog
    /// default, e.g. an unrecognized short_code — see
    /// cloud/lib/entry-defaults.ts's defaultQuantity: "never invent a
    /// number"), plus whether that value came from the catalog default
    /// table rather than this specific vaccine row.</summary>
    public readonly record struct Resolution(string? Value, bool UsedDefault)
    {
        public static readonly Resolution None = new(null, UsedDefault: false);
    }

    /// <summary>Vaccine.Quantity when non-blank; else Vaccine.QuantityDefault
    /// (the server-computed per-product-type default) when non-blank; else
    /// Resolution.None — InputQuantityStep.cs still prompts staff in that
    /// last case rather than ever guessing a number.</summary>
    public static Resolution ResolveQuantity(Vaccine vaccine) => Resolve(vaccine.Quantity, vaccine.QuantityDefault);

    /// <summary>Same as ResolveQuantity, for Directions. In practice this
    /// should resolve to a default far more often than Quantity does —
    /// cloud/lib/entry-defaults.ts's defaultDirections always returns a
    /// value (the fixed "For administration by healthcare provider in
    /// pharmacy." sig, "Dose N — " prefixed for a multi-dose series),
    /// unlike defaultQuantity, which can legitimately return null for an
    /// unrecognized product.</summary>
    public static Resolution ResolveDirections(Vaccine vaccine) => Resolve(vaccine.Directions, vaccine.DirectionsDefault);

    private static Resolution Resolve(string? onFile, string? catalogDefault)
    {
        if (!string.IsNullOrWhiteSpace(onFile)) return new Resolution(onFile, UsedDefault: false);
        if (!string.IsNullOrWhiteSpace(catalogDefault)) return new Resolution(catalogDefault, UsedDefault: true);
        return Resolution.None;
    }
}
