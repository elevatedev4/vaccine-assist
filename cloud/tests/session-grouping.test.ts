import { describe, expect, it } from "vitest";
import { groupSessionsByDevice, type SessionRow } from "@/lib/session-grouping";

function row(overrides: Partial<SessionRow> & Pick<SessionRow, "id">): SessionRow {
  return {
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    refreshed_at: null,
    user_agent: null,
    ip: null,
    ...overrides,
  };
}

describe("groupSessionsByDevice", () => {
  it("returns one group per row when user_agent/ip differ", () => {
    const rows = [
      row({ id: "a", user_agent: "Mozilla/5.0 Chrome/128", ip: "1.1.1.1" }),
      row({ id: "b", user_agent: null, ip: "2.2.2.2" }),
    ];

    const groups = groupSessionsByDevice(rows, null);

    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.sessionCount)).toEqual([1, 1]);
  });

  it("folds sessions sharing the same user_agent AND ip into one group", () => {
    const rows = [
      row({ id: "launch-1", created_at: "2026-08-01T00:00:00.000Z", refreshed_at: "2026-08-01T00:00:00.000Z", ip: "9.9.9.9" }),
      row({ id: "launch-2", created_at: "2026-08-05T00:00:00.000Z", refreshed_at: "2026-08-05T00:00:00.000Z", ip: "9.9.9.9" }),
      row({ id: "launch-3", created_at: "2026-08-10T00:00:00.000Z", refreshed_at: "2026-08-10T00:00:00.000Z", ip: "9.9.9.9" }),
    ];

    const groups = groupSessionsByDevice(rows, null);

    expect(groups).toHaveLength(1);
    expect(groups[0].sessionCount).toBe(3);
    expect(groups[0].sessionIds.sort()).toEqual(["launch-1", "launch-2", "launch-3"]);
    // Earliest createdAt across the group ("when this device first signed
    // in"), most recent lastActiveAt ("when this device was last seen").
    expect(groups[0].createdAt).toBe("2026-08-01T00:00:00.000Z");
    expect(groups[0].lastActiveAt).toBe("2026-08-10T00:00:00.000Z");
    // The representative row's device label comes from the
    // most-recently-active session in the group.
    expect(groups[0].id).toBe("launch-3");
  });

  it("does NOT merge the same user_agent across different ips", () => {
    const rows = [
      row({ id: "pc-1", user_agent: null, ip: "1.1.1.1" }),
      row({ id: "pc-2", user_agent: null, ip: "2.2.2.2" }),
    ];

    const groups = groupSessionsByDevice(rows, null);

    expect(groups).toHaveLength(2);
  });

  it("marks a group current when ANY session folded into it is the caller's current session", () => {
    const rows = [
      row({ id: "old", ip: "9.9.9.9", created_at: "2026-08-01T00:00:00.000Z" }),
      row({ id: "current", ip: "9.9.9.9", created_at: "2026-08-05T00:00:00.000Z" }),
    ];

    const groups = groupSessionsByDevice(rows, "current");

    expect(groups).toHaveLength(1);
    expect(groups[0].isCurrent).toBe(true);
  });

  it("treats null user_agent and null ip consistently (does not crash, still groups)", () => {
    const rows = [row({ id: "a" }), row({ id: "b" })];

    const groups = groupSessionsByDevice(rows, null);

    expect(groups).toHaveLength(1);
    expect(groups[0].sessionCount).toBe(2);
  });

  it("falls back lastActiveAt to updated_at when refreshed_at is null", () => {
    const rows = [row({ id: "a", updated_at: "2026-05-05T00:00:00.000Z", refreshed_at: null })];

    const groups = groupSessionsByDevice(rows, null);

    expect(groups[0].lastActiveAt).toBe("2026-05-05T00:00:00.000Z");
  });

  it("sorts groups by most-recently-active first", () => {
    const rows = [
      row({ id: "stale", ip: "1.1.1.1", refreshed_at: "2026-01-01T00:00:00.000Z" }),
      row({ id: "fresh", ip: "2.2.2.2", refreshed_at: "2026-09-01T00:00:00.000Z" }),
    ];

    const groups = groupSessionsByDevice(rows, null);

    expect(groups.map((g) => g.id)).toEqual(["fresh", "stale"]);
  });
});
