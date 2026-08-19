using System;
using System.Collections.Generic;
using FlaUI.Core.AutomationElements;
using FlaUI.UIA3;

namespace VaccineAssist.Desktop.Uia;

/// <summary>
/// Finds and attaches to the active PioneerRx window using UIA3, for the
/// data-entry sequence's FocusPioneerWindowStep. Modeled directly on
/// rx-verify's overlay/RxVerifyOverlay/Uia/PioneerRxWindow.cs (same "find
/// a top-level window whose title starts with a known prefix" approach)
/// but intentionally WITHOUT that class's attach-cache/latency
/// optimizations — this only runs once per data-entry popup session (not
/// on a fast repeating refresh timer like rx-verify's overlay), so the
/// extra complexity isn't earning its keep here. Revisit if that changes.
///
/// TITLE CAVEAT: see PioneerRxTitles.cs — the exact window this should
/// attach to for vaccine entry hasn't been confirmed against a live UIA
/// dump yet. TryAttach matches the same prefixes rx-verify confirmed for
/// its own (Rx Profile) screens as the best available signal.
/// </summary>
public static class PioneerRxAttachment
{
    /// <summary>
    /// Attempts to find a top-level window whose title starts with one of
    /// PioneerRxTitles.TargetWindowTitlePrefixes. Returns null (never
    /// throws) if none is open or the UIA session itself fails — callers
    /// treat that as "PioneerRx not found" and fall back accordingly
    /// (dry-run / clipboard), never crash.
    /// </summary>
    public static AutomationElement? TryAttach()
    {
        try
        {
            using var automation = new UIA3Automation();
            var desktop = automation.GetDesktop();
            var allTopLevel = desktop.FindAllChildren();

            var candidates = new List<AutomationElement>();
            foreach (var window in allTopLevel)
            {
                string? name;
                try { name = window.Name; }
                catch { continue; }

                if (name is null) continue;

                foreach (var prefix in PioneerRxTitles.TargetWindowTitlePrefixes)
                {
                    if (name.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                    {
                        candidates.Add(window);
                        break;
                    }
                }
            }

            // Single-candidate is the common case; with more than one
            // open, first-match is an acceptable simplification for
            // phase 1 (unlike rx-verify's refresh-timer loop, this
            // isn't at risk of getting permanently stuck on a stale
            // window — the pharmacist re-triggers the hotkey per patient).
            return candidates.Count > 0 ? candidates[0] : null;
        }
        catch
        {
            return null;
        }
    }
}
