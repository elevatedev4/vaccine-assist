/**
 * /macro-codes embed mode (V-macro-codes-round9, Will verbatim,
 * 2026-09-13): "Make a macro code popup in the vaccine assist app that
 * pops up this screen we built when someone pushes Ctrl+8. When they
 * click on the one they want, it copies the macro code and closes the
 * page so they can go resume data entry themselves." The desktop (WPF)
 * half opens `/macro-codes?embed=1` in its own popup/WebView2 host and
 * listens for these messages; this file is the CLOUD side of that
 * contract — a plain data shape plus the one function that sends it,
 * so app/macro-codes/page.tsx's embed-mode click/Escape handlers stay
 * thin call sites.
 *
 * Two possible hosts, checked independently (a build could be embedded
 * either way, or — in a plain browser tab with no host at all — neither):
 *   - the WPF desktop shell's WebView2 control, reachable via the
 *     browser-injected `window.chrome.webview.postMessage`;
 *   - a browser <iframe> host, reachable via `window.parent.postMessage`
 *     (parent !== window is the iframe check — a top-level tab's parent
 *     is itself).
 * postToHost tries both and is a silent no-op when neither is present
 * (e.g. someone opens the embed URL directly in a normal tab) — it
 * never throws.
 */

/** Sent after a dose/Copy button's clipboard copy succeeds. `code` is
 * the exact macro text that was copied, `label` the dose button's full
 * descriptive label (e.g. "Abrysvo (75+, 18+ high-risk)"), `product`
 * the product's display name (e.g. "Abrysvo"). */
export type MacroCopiedMessage = {
  type: "vaccine-assist:macro-copied";
  code: string;
  label: string;
  product: string;
};

/** Sent when the user backs out of the popup (Escape) without copying
 * anything. */
export type MacroCancelMessage = { type: "vaccine-assist:macro-cancel" };

/**
 * Macro-popup round 3 (Will's verbatim ask, 2026-09-25): "make the
 * height fit only what it needs to be able to show everything, not
 * extra space at the bottom." Sent after this page's first paint and
 * again on every subsequent content-size change (a ResizeObserver on
 * `document.documentElement` — see app/macro-codes/page.tsx) so
 * MacroCodesWindow can size its window to the content instead of a
 * fixed guess. `width`/`height` are CSS px — `document.documentElement.
 * scrollHeight` for height — which WebView2 reports (and the desktop
 * host applies) as WPF DIPs directly, since the page renders at the
 * host's default zoom.
 */
export type ContentSizeMessage = {
  type: "vaccine-assist:content-size";
  width: number;
  height: number;
};

export type MacroEmbedMessage = MacroCopiedMessage | MacroCancelMessage | ContentSizeMessage;

/** Minimal shape of the WebView2 bridge object the host page injects as
 * `window.chrome.webview` — not part of the standard DOM lib types, so
 * this is its own tiny local type rather than `any`. */
type WebView2Host = { postMessage: (message: unknown) => void };

/**
 * Posts `message` to whichever embed host is listening. Both channels
 * are tried independently (a page could in principle be reachable by
 * both) and neither is required — this never throws even when `window`
 * has no `chrome.webview` and no real parent frame.
 */
export function postToHost(message: MacroEmbedMessage): void {
  const webview = (window as unknown as { chrome?: { webview?: WebView2Host } }).chrome?.webview;
  if (webview && typeof webview.postMessage === "function") {
    webview.postMessage(message);
  }

  if (window.parent && window.parent !== window) {
    window.parent.postMessage(message, "*");
  }
}

/** Convenience wrapper around postToHost for a ContentSizeMessage —
 * callers just pass the two numbers instead of building the message
 * shape by hand. */
export function postContentSize(width: number, height: number): void {
  postToHost({ type: "vaccine-assist:content-size", width, height });
}
