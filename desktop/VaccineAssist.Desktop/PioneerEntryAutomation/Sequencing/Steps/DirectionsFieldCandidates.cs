using System;
using System.Collections.Generic;
using System.Linq;

namespace VaccineAssist.Desktop.PioneerEntryAutomation.Sequencing.Steps;

/// <summary>
/// One enabled Edit/Document/ComboBox descendant of whichever PioneerRx
/// window is being searched — NO field VALUE (patient data), only the
/// structural attributes needed to decide "is this the directions/sig
/// field": AutomationId, Name, ClassName, ControlType (a plain string,
/// e.g. "Edit"/"Document" — FlaUI's ControlType.ToString()), and Bounds
/// (only used for the diagnostic dump, never for matching). Shared by
/// InputDirectionsStep's live candidate search and
/// Uia/EditableFieldDumper's collector so the matcher stays UIA/FlaUI-free
/// and directly unit-testable (see DirectionsFieldCandidatesTests.cs).
/// </summary>
public readonly record struct FieldDescriptor(
    string? AutomationId, string? Name, string? ClassName, string? ControlType, string? Bounds = null);

/// <summary>
/// V-T41 R5 (Will, 2026-09-29 8:15pm, verbatim): quantity entry now
/// succeeds but "[Enter directions] FAILED — Couldn't find the directions
/// field (AutomationId 'uxDirections')" — InputDirectionsStep.
/// DirectionsAutomationId's own doc comment already flagged that id as an
/// UNCONFIRMED placeholder. Rather than depending on that one guess, the
/// live step now tries an ORDERED list of plausible AutomationIds (this
/// class), then falls back to a keyword search over whatever enabled
/// Edit/Document fields are actually on screen.
///
/// PURE matcher, no FlaUI/UIA dependency — the live step
/// (InputDirectionsStep) does the actual polling/searching against a real
/// PioneerRx window and hands the result in as a flat list of
/// FieldDescriptor; this just decides which one (if any) is the
/// directions/sig field. See DirectionsFieldCandidatesTests.cs.
/// </summary>
public static class DirectionsFieldCandidates
{
    /// <summary>
    /// Checked in this exact order — "uxDirections" first (the original,
    /// still-unconfirmed guess; keeping it first costs nothing if it turns
    /// out to be right, and this whole class exists so a WRONG guess here
    /// no longer fails the step outright), then three more plausible
    /// PioneerRx-style ids for the same field.
    /// </summary>
    public static readonly IReadOnlyList<string> AutomationIds = new[]
    {
        InputDirectionsStep.DirectionsAutomationId, // "uxDirections"
        "uxSig",
        "uxDirectionsText",
        "uxSigText",
    };

    private static readonly string[] Keywords = { "direction", "sig" };

    /// <summary>Control types the keyword fallback will consider — matches
    /// the brief verbatim ("any Edit/Document control"). ComboBox is
    /// collected for the diagnostic dump (Uia/EditableFieldDumper) but
    /// deliberately NOT matched here — a directions/sig field is free text,
    /// never a combo box.</summary>
    private static readonly string[] KeywordControlTypes = { "Edit", "Document" };

    /// <summary>
    /// Given every enabled Edit/Document/ComboBox descendant already
    /// collected from the window(s) being searched (no live UIA call made
    /// here), returns the best match: first, an EXACT (case-insensitive)
    /// AutomationId match against <see cref="AutomationIds"/>, checked in
    /// that order across the whole candidate list before moving to the
    /// next id; failing that, the first Edit/Document candidate whose Name
    /// OR AutomationId contains "direction" or "sig" (case-insensitive) —
    /// but ONLY when that candidate has a non-blank AutomationId, since
    /// InputDirectionsStep can only act on a field it can re-find by id
    /// (QuickSearchFieldEntry.TypeAndConfirmAsync's own ByAutomationId
    /// lookup). A Name-only match with no AutomationId still shows up in
    /// the diagnostic dump (EditableFieldDumper.DescribeForLog) for Will to
    /// read, it just isn't returned here as an actionable match. Null when
    /// nothing qualifies.
    /// </summary>
    public static FieldDescriptor? TryMatch(IReadOnlyList<FieldDescriptor> candidates)
    {
        foreach (var id in AutomationIds)
        {
            foreach (var candidate in candidates)
            {
                if (!string.IsNullOrEmpty(candidate.AutomationId) &&
                    string.Equals(candidate.AutomationId, id, StringComparison.OrdinalIgnoreCase))
                {
                    return candidate;
                }
            }
        }

        foreach (var candidate in candidates)
        {
            if (string.IsNullOrEmpty(candidate.AutomationId)) continue;
            if (candidate.ControlType is null ||
                !KeywordControlTypes.Contains(candidate.ControlType, StringComparer.OrdinalIgnoreCase))
            {
                continue;
            }

            if (ContainsKeyword(candidate.Name) || ContainsKeyword(candidate.AutomationId))
            {
                return candidate;
            }
        }

        return null;
    }

    private static bool ContainsKeyword(string? text) =>
        !string.IsNullOrEmpty(text) && Keywords.Any(k => text.Contains(k, StringComparison.OrdinalIgnoreCase));
}
