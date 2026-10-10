import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { listLimitSwitchTargets, suggestLimitSwitch } from "./limitSwitchTargets.ts";

const NOW = Date.parse("2026-10-10T12:00:00.000Z");

function provider(
  instanceId: string,
  overrides: Partial<ServerProvider> = {},
  driver = "codex",
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-10T11:59:00.000Z",
    models: [{ slug: "gpt-6", name: "GPT-6", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

function usage(usedPercent: number, resetsAt?: string): ServerProvider["usageLimits"] {
  return {
    checkedAt: "2026-10-10T11:59:00.000Z",
    windows: [
      {
        id: "primary",
        kind: "session",
        label: "5 hours",
        usedPercent,
        ...(resetsAt ? { resetsAt } : {}),
      },
    ],
  };
}

const current: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6",
};

function targetIds(providers: ReadonlyArray<ServerProvider>) {
  return listLimitSwitchTargets({ providers, current, nowMs: NOW }).map(
    (target) => target.selection.instanceId,
  );
}

describe("listLimitSwitchTargets", () => {
  it("offers a ready, signed-in sibling and keeps the thread's model", () => {
    const [target] = listLimitSwitchTargets({
      providers: [provider("codex"), provider("codex_personal", { usageLimits: usage(40) })],
      current: { ...current, options: [{ id: "effort", value: "high" }] },
      nowMs: NOW,
    });
    expect(target?.selection).toEqual({
      instanceId: "codex_personal",
      model: "gpt-6",
      options: [{ id: "effort", value: "high" }],
    });
    expect(target?.label).toBe("Codex Personal");
    expect(target?.remainingPercent).toBe(60);
  });

  it("skips the current instance, other drivers, and instances that cannot run the turn", () => {
    expect(
      targetIds([
        provider("codex"),
        provider("claude", {}, "claudeAgent"),
        provider("codex_disabled", { enabled: false }),
        provider("codex_signed_out", { auth: { status: "unauthenticated" } }),
        provider("codex_broken", { status: "error" }),
        provider("codex_unavailable", { availability: "unavailable" }),
        provider("codex_other_model", {
          models: [{ slug: "gpt-5", name: "GPT-5", isCustom: false, capabilities: null }],
        }),
      ]),
    ).toEqual([]);
  });

  it("drops an account that is out of quota until its window resets", () => {
    expect(
      targetIds([
        provider("codex"),
        provider("codex_a", { usageLimits: usage(100, "2026-10-10T15:00:00.000Z") }),
        provider("codex_b", { usageLimits: usage(100, "2026-10-10T11:00:00.000Z") }),
      ]),
    ).toEqual(["codex_b"]);
  });

  it("puts the same continuation group first, then the most headroom", () => {
    const group = { groupKey: "codex:home:/home/me/.codex" };
    expect(
      targetIds([
        provider("codex", { continuation: group }),
        provider("codex_separate", { usageLimits: usage(5) }),
        provider("codex_shared_busy", { continuation: group, usageLimits: usage(70) }),
        provider("codex_shared_free", { continuation: group, usageLimits: usage(10) }),
      ]),
    ).toEqual(["codex_shared_free", "codex_shared_busy", "codex_separate"]);
  });

  it("returns nothing when the thread's instance is unknown", () => {
    expect(
      listLimitSwitchTargets({
        providers: [provider("codex_personal")],
        current,
        nowMs: NOW,
      }),
    ).toEqual([]);
  });
});

describe("suggestLimitSwitch", () => {
  const weeklyUsedUp: ServerProvider["usageLimits"] = {
    checkedAt: "2026-10-10T11:59:00.000Z",
    windows: [
      { id: "primary", kind: "session", label: "Session", usedPercent: 20 },
      {
        id: "secondary",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 100,
        resetsAt: "2026-10-14T02:00:00.000Z",
      },
    ],
  };

  it("names the used-up window and the accounts that can take over", () => {
    const suggestion = suggestLimitSwitch({
      providers: [
        provider("codex", { displayName: "Work", usageLimits: weeklyUsedUp }),
        provider("codex_personal"),
      ],
      current,
      nowMs: NOW,
    });
    expect(suggestion?.sourceLabel).toBe("Work");
    expect(suggestion?.window.id).toBe("secondary");
    expect(suggestion?.remainingPercent).toBe(0);
    expect(suggestion?.targets.map((target) => target.selection.instanceId)).toEqual([
      "codex_personal",
    ]);
  });

  it("gives a heads-up once a window is nearly used up", () => {
    const suggestion = suggestLimitSwitch({
      providers: [provider("codex", { usageLimits: usage(93) }), provider("codex_personal")],
      current,
      nowMs: NOW,
    });
    expect(suggestion?.window.id).toBe("primary");
    expect(suggestion?.remainingPercent).toBe(7);
  });

  it("stays quiet while the account has allowance left or nobody can take over", () => {
    expect(
      suggestLimitSwitch({
        providers: [provider("codex", { usageLimits: usage(89) }), provider("codex_personal")],
        current,
        nowMs: NOW,
      }),
    ).toBeNull();
    expect(
      suggestLimitSwitch({
        providers: [provider("codex", { usageLimits: weeklyUsedUp })],
        current,
        nowMs: NOW,
      }),
    ).toBeNull();
  });
});
