import { afterEach, describe, expect, it, vi } from "vitest";
import { postToHost, type MacroEmbedMessage } from "@/lib/macro-embed";

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
