using System.Linq;

namespace VaccineAssist.Desktop.Fax;

/// <summary>
/// Normalizes a pasted Notifyre API token before it's saved AND again
/// right before it's used on a request, so paste artifacts a user can't
/// see (and can't tell apart from "the token is just wrong") turn into
/// the SAME working token instead of a silent 401 — Notifyre returns a
/// byte-identical "Access denied" body for a missing token and for a
/// garbage one (see NotifyreFaxClient's own doc comment).
///
/// V-T53 follow-up (Will, 2026-09-25, verbatim: "I know the token is
/// correct. I got it myself... Fix the app."): a plain <c>.Trim()</c>
/// (already applied before this class existed, in both
/// FaxSettingsViewModel and NotifyreFaxClient.BuildRequest) only strips
/// characters <c>char.IsWhiteSpace</c> recognizes — regular space, tab,
/// \r, \n, and a handful of Unicode space separators. It does NOT strip
/// zero-width/invisible FORMAT characters (zero-width space U+200B,
/// zero-width non-joiner/joiner U+200C/U+200D, word joiner U+2060,
/// zero-width no-break space / UTF-8 BOM U+FEFF) that a copy from a web
/// dashboard, a PDF, or a rich-text source can silently carry along with
/// an otherwise byte-perfect token — <c>char.IsWhiteSpace</c> returns
/// false for every one of those, so they survive Trim() invisibly and
/// make the token Notifyre receives not match the one Will pasted. Also
/// strips a pasted "Bearer " scheme prefix (copying an Authorization
/// header example instead of the bare token Notifyre's x-api-token header
/// actually wants) and a single pair of surrounding quotes (copying a
/// JSON-quoted value, e.g. from a dashboard's "copy as JSON" button).
/// </summary>
public static class FaxApiTokenNormalizer
{
    // Written as explicit \uXXXX escapes (not the literal invisible
    // characters) so this array survives any future edit/diff/encoding
    // round-trip legibly instead of as blank-looking glyphs.
    private static readonly char[] ZeroWidthOrFormatChars =
    {
        '​', // zero-width space
        '‌', // zero-width non-joiner
        '‍', // zero-width joiner
        '⁠', // word joiner
        '﻿', // zero-width no-break space / BOM
    };

    private const string BearerPrefix = "Bearer ";

    public static string Normalize(string? raw)
    {
        if (string.IsNullOrEmpty(raw))
        {
            return "";
        }

        var value = raw;

        // Zero-width/format characters can sit anywhere (not just the
        // ends — e.g. two clipboard fragments concatenated with an
        // invisible joiner between them), so strip those before Trim()
        // ever runs, then strip ordinary leading/trailing whitespace and
        // any other control character (a stray \r or \t embedded
        // mid-string that a multi-line paste didn't get filtered from).
        foreach (var ch in ZeroWidthOrFormatChars)
        {
            value = value.Replace(ch.ToString(), "");
        }

        value = new string(value.Where(c => !char.IsControl(c)).ToArray()).Trim();

        // A single pair of surrounding quotes (copied from a JSON value
        // like "abc123", including the quotes).
        if (value.Length >= 2 &&
            ((value[0] == '"' && value[^1] == '"') || (value[0] == '\'' && value[^1] == '\'')))
        {
            value = value[1..^1].Trim();
        }

        // A pasted "Bearer <token>" instead of the bare token.
        if (value.StartsWith(BearerPrefix, System.StringComparison.OrdinalIgnoreCase))
        {
            value = value[BearerPrefix.Length..].Trim();
        }

        return value;
    }
}
