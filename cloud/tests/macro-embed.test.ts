import { afterEach, describe, expect, it, vi } from "vitest";
import { postContentSize, postToHost, type ContentSizeMessage, type MacroEmbedMessage } from "@/lib/macro-embed";

const COPIED_MESSAGE: MacroEmbedMessage = {
  type: "vaccine-assist:macro-copied",
  code: "abrysvo,ABC123,09132026",
  label: "Abrysvo (75+, 18+ high-risk)",
  product: "Abrysvo",
};

const CANCEL_MESSAGE: MacroEmbedMessage = { type: "vaccine-assist:macro-cancel" };

describe("postToHost", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts to the WebView2 host when window.chrome.webview is present", () => {
    const webviewPostMessage = vi.fn();
    const fakeWindow = { chrome: { webview: { postMessage: webviewPostMessage } }, parent: undefined as unknown };
    fakeWindow.parent = fakeWindow; // top-level window: parent === self
    vi.stubGlobal("window", fakeWindow);

    postToHost(COPIED_MESSAGE);

    expect(webviewPostMessage).toHaveBeenCalledTimes(1);
    expect(webviewPostMessage).toHaveBeenCalledWith(COPIED_MESSAGE);
  });

  it("posts to window.parent via postMessage(msg, '*') when embedded in an iframe", () => {
    const parentPostMessage = vi.fn();
    const fakeParent = { postMessage: parentPostMessage };
    vi.stubGlobal("window", { parent: fakeParent });

    postToHost(CANCEL_MESSAGE);

    expect(parentPostMessage).toHaveBeenCalledTimes(1);
    expect(parentPostMessage).toHaveBeenCalledWith(CANCEL_MESSAGE, "*");
  });

  it("posts to BOTH hosts when both are present", () => {
    const webviewPostMessage = vi.fn();
    const parentPostMessage = vi.fn();
    vi.stubGlobal("window", {
      chrome: { webview: { postMessage: webviewPostMessage } },
      parent: { postMessage: parentPostMessage },
    });

    postToHost(COPIED_MESSAGE);

    expect(webviewPostMessage).toHaveBeenCalledWith(COPIED_MESSAGE);
    expect(parentPostMessage).toHaveBeenCalledWith(COPIED_MESSAGE, "*");
  });

  it("is a silent no-op when neither host exists (plain top-level tab, no WebView2)", () => {
    const fakeWindow = { parent: undefined as unknown };
    fakeWindow.parent = fakeWindow; // top-level window: parent === self, no chrome.webview
    vi.stubGlobal("window", fakeWindow);

    expect(() => postToHost(COPIED_MESSAGE)).not.toThrow();
  });

  it("does not call window.chrome.webview.postMessage when chrome.webview is absent", () => {
    const parentPostMessage = vi.fn();
    vi.stubGlobal("window", { parent: { postMessage: parentPostMessage } });

    postToHost(CANCEL_MESSAGE);

    expect(parentPostMessage).toHaveBeenCalledWith(CANCEL_MESSAGE, "*");
  });
});

// MACRO-POPUP ROUND 3 (Will's verbatim ask, 2026-09-25): postContentSize
// is the shape/plumbing half of "make the height fit only what it
// needs" — this page reports its own size, MacroCodesWindow.xaml.cs
// resizes the window to match. postToHost's own dual-channel/no-throw
// behavior is already fully covered above; these tests just confirm
// postContentSize builds the right message shape and hands it to the
// same postToHost path.
describe("postContentSize", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts a vaccine-assist:content-size message with the given width/height", () => {
    const webviewPostMessage = vi.fn();
    const fakeWindow = { chrome: { webview: { postMessage: webviewPostMessage } }, parent: undefined as unknown };
    fakeWindow.parent = fakeWindow;
    vi.stubGlobal("window", fakeWindow);

    postContentSize(1300, 842);

    const expected: ContentSizeMessage = { type: "vaccine-assist:content-size", width: 1300, height: 842 };
    expect(webviewPostMessage).toHaveBeenCalledTimes(1);
    expect(webviewPostMessage).toHaveBeenCalledWith(expected);
  });

  it("reaches an iframe host via window.parent.postMessage(msg, '*') too", () => {
    const parentPostMessage = vi.fn();
    vi.stubGlobal("window", { parent: { postMessage: parentPostMessage } });

    postContentSize(980, 600);

    expect(parentPostMessage).toHaveBeenCalledWith(
      { type: "vaccine-assist:content-size", width: 980, height: 600 },
      "*"
    );
  });

  it("is a silent no-op when neither host exists", () => {
    const fakeWindow = { parent: undefined as unknown };
    fakeWindow.parent = fakeWindow;
    vi.stubGlobal("window", fakeWindow);

    expect(() => postContentSize(1024, 768)).not.toThrow();
  });
});
