import { describe, expect, it, vi } from "vitest";
import { subscribeToSessionState, toSessionState } from "@/lib/supabase/session";
import type { Session, SupabaseClient } from "@supabase/supabase-js";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    access_token: "token-abc",
    refresh_token: "refresh-abc",
    expires_in: 3600,
    token_type: "bearer",
    user: { email: "pharmacist@example.com" } as Session["user"],
    ...overrides,
  } as Session;
}

/**
 * Minimal fake of the slice of SupabaseClient this module touches
 * (auth.getSession + auth.onAuthStateChange). Lets subscribeToSessionState
 * be tested without a real network/Supabase project, matching how other
 * tests in this suite avoid live-service dependencies.
 */
function makeFakeSupabase(initialSession: Session | null) {
  let changeCallback: ((event: string, session: Session | null) => void) | null = null;
  const unsubscribe = vi.fn();

  const supabase = {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: initialSession }, error: null })),
      onAuthStateChange: vi.fn((cb: (event: string, session: Session | null) => void) => {
        changeCallback = cb;
        return { data: { subscription: { unsubscribe } } };
      }),
    },
  } as unknown as SupabaseClient;

  return {
    supabase,
    unsubscribe,
    emitChange: (event: string, session: Session | null) => changeCallback?.(event, session),
  };
}

describe("toSessionState", () => {
  it("returns null for a null session", () => {
    expect(toSessionState(null)).toBeNull();
  });

  it("projects access_token and user email", () => {
    expect(toSessionState(makeSession())).toEqual({
      accessToken: "token-abc",
      email: "pharmacist@example.com",
    });
  });

  it("falls back to a null email when the user has none", () => {
    const session = makeSession({ user: {} as Session["user"] });
    expect(toSessionState(session)).toEqual({ accessToken: "token-abc", email: null });
  });
});

describe("subscribeToSessionState", () => {
  it("hydrates from getSession on call", async () => {
    const { supabase } = makeFakeSupabase(makeSession());
    const onChange = vi.fn();
    subscribeToSessionState(supabase, onChange);

    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith({
      accessToken: "token-abc",
      email: "pharmacist@example.com",
    }));
  });

  it("reports null when there is no persisted session", async () => {
    const { supabase } = makeFakeSupabase(null);
    const onChange = vi.fn();
    subscribeToSessionState(supabase, onChange);

    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith(null));
  });

  it("keeps state in sync via onAuthStateChange (sign-in after mount)", async () => {
    const { supabase, emitChange } = makeFakeSupabase(null);
    const onChange = vi.fn();
    subscribeToSessionState(supabase, onChange);

    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith(null));
    onChange.mockClear();

    emitChange("SIGNED_IN", makeSession());
    expect(onChange).toHaveBeenCalledWith({ accessToken: "token-abc", email: "pharmacist@example.com" });
  });

  it("reports null on sign-out via onAuthStateChange", async () => {
    const { supabase, emitChange } = makeFakeSupabase(makeSession());
    const onChange = vi.fn();
    subscribeToSessionState(supabase, onChange);

    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith({
      accessToken: "token-abc",
      email: "pharmacist@example.com",
    }));
    onChange.mockClear();

    emitChange("SIGNED_OUT", null);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("stops calling onChange after unsubscribe, and unsubscribes the underlying subscription", async () => {
    const { supabase, unsubscribe, emitChange } = makeFakeSupabase(null);
    const onChange = vi.fn();
    const teardown = subscribeToSessionState(supabase, onChange);

    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith(null));
    onChange.mockClear();

    teardown();
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    emitChange("SIGNED_IN", makeSession());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not call onChange from a late-resolving getSession after unsubscribe", async () => {
    let resolveGetSession!: (value: { data: { session: Session | null }; error: null }) => void;
    const onChange = vi.fn();
    const supabase = {
      auth: {
        getSession: vi.fn(
          () =>
            new Promise((resolve) => {
              resolveGetSession = resolve;
            })
        ),
        onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      },
    } as unknown as SupabaseClient;

    const teardown = subscribeToSessionState(supabase, onChange);
    teardown();
    resolveGetSession({ data: { session: makeSession() }, error: null });

    await new Promise((r) => setTimeout(r, 0));
    expect(onChange).not.toHaveBeenCalled();
  });
});
