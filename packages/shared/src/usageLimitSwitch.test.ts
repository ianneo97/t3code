import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { selectionAfterExhaustedLimit } from "./usageLimitSwitch.ts";

const NOW = Date.parse("2026-10-10T12:00:00.000Z");

function provider(
  instanceId: string,
  weeklyUsed: number | null,
  overrides: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-10T11:59:00.000Z",
    models: [{ slug: "gpt-6", name: "GPT-6", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
    ...(weeklyUsed === null
      ? {}
      : {
          usageLimits: {
            checkedAt: "2026-10-10T11:59:00.000Z",
            windows: [
              {
                id: "secondary",
                kind: "weekly" as const,
                label: "Weekly",
                usedPercent: weeklyUsed,
                resetsAt: "2026-10-14T02:00:00.000Z",
              },
            ],
          },
        }),
    ...overrides,
  };
}

const current: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6",
  options: [{ id: "effort", value: "high" }],
};

describe("selectionAfterExhaustedLimit", () => {
  it("moves a used-up account's turn to the account with the most allowance, keeping model and options", () => {
    expect(
      selectionAfterExhaustedLimit({
        providers: [provider("codex", 100), provider("codex_busy", 70), provider("codex_free", 10)],
        current,
        nowMs: NOW,
      }),
    ).toEqual({ ...current, instanceId: "codex_free" });
  });

  it("leaves the turn alone while the account has allowance, or reports none", () => {
    expect(
      selectionAfterExhaustedLimit({
        providers: [provider("codex", 99), provider("codex_free", 10)],
        current,
        nowMs: NOW,
      }),
    ).toBeNull();
    expect(
      selectionAfterExhaustedLimit({
        providers: [provider("codex", null), provider("codex_free", 10)],
        current,
        nowMs: NOW,
      }),
    ).toBeNull();
  });

  it("leaves the turn alone when no other account can take it", () => {
    expect(
      selectionAfterExhaustedLimit({
        providers: [
          provider("codex", 100),
          provider("codex_out", 100),
          provider("codex_signed_out", 5, { auth: { status: "unauthenticated" } }),
          provider("claude", 5, { driver: ProviderDriverKind.make("claudeAgent") }),
        ],
        current,
        nowMs: NOW,
      }),
    ).toBeNull();
  });

  it("never moves a turn onto an account that bills per token", () => {
    expect(
      selectionAfterExhaustedLimit({
        providers: [
          provider("codex", 100),
          provider("codex_api_key", null),
          provider("codex_unsupported", null, {
            usageLimits: {
              checkedAt: "2026-10-10T11:59:00.000Z",
              windows: [],
              unavailable: { reason: "unsupported" },
            },
          }),
        ],
        current,
        nowMs: NOW,
      }),
    ).toBeNull();
  });

  const claudeModels = ["claude-fable-5-1", "claude-haiku-5-5", "claude-opus-5-5"].map((slug) => ({
    slug,
    name: slug,
    isCustom: false,
    capabilities: null,
  }));
  function usageLimits(windows: ReadonlyArray<[id: string, used: number]>) {
    return {
      checkedAt: "2026-10-10T11:59:00.000Z",
      windows: windows.map(([id, usedPercent]) => ({
        id,
        kind: "weekly" as const,
        label: id,
        usedPercent,
        resetsAt: "2026-10-14T02:00:00.000Z",
      })),
    };
  }
  function claude(instanceId: string, windows: ReadonlyArray<[id: string, used: number]>) {
    return provider(instanceId, null, {
      driver: ProviderDriverKind.make("claudeAgent"),
      models: claudeModels,
      usageLimits: usageLimits(windows),
    });
  }
  const on = (instanceId: string, model: string): ModelSelection => ({
    instanceId: ProviderInstanceId.make(instanceId),
    model,
  });

  it("counts a model's own weekly window only for turns of that model", () => {
    const fableUsedUp = claude("claude_fable_out", [
      ["five_hour", 10],
      ["seven_day", 40],
      ["seven_day_fable", 100],
    ]);
    const sessionUsedUp = claude("claude_session_out", [["five_hour", 100]]);
    const free = claude("claude_free", [["five_hour", 5]]);

    expect(
      selectionAfterExhaustedLimit({
        providers: [fableUsedUp, sessionUsedUp],
        current: on("claude_session_out", "claude-haiku-5-5"),
        nowMs: NOW,
      }),
    ).toEqual(on("claude_fable_out", "claude-haiku-5-5"));
    expect(
      selectionAfterExhaustedLimit({
        providers: [fableUsedUp, sessionUsedUp],
        current: on("claude_session_out", "claude-fable-5-1"),
        nowMs: NOW,
      }),
    ).toBeNull();
    for (const model of ["claude-haiku-5-5", "claude-opus-5-5"]) {
      expect(
        selectionAfterExhaustedLimit({
          providers: [fableUsedUp, free],
          current: on("claude_fable_out", model),
          nowMs: NOW,
        }),
      ).toBeNull();
    }
    expect(
      selectionAfterExhaustedLimit({
        providers: [fableUsedUp, free],
        current: on("claude_fable_out", "claude-fable-5-1"),
        nowMs: NOW,
      }),
    ).toEqual(on("claude_free", "claude-fable-5-1"));
  });

  it("does not treat a spent extra-usage or credit budget as a used-up plan", () => {
    expect(
      selectionAfterExhaustedLimit({
        providers: [
          claude("claude_spent", [
            ["five_hour", 20],
            ["monthly_spend", 100],
          ]),
          claude("claude_free", [["five_hour", 5]]),
        ],
        current: on("claude_spent", "claude-opus-5-5"),
        nowMs: NOW,
      }),
    ).toBeNull();
    expect(
      selectionAfterExhaustedLimit({
        providers: [
          provider("codex", null, {
            usageLimits: usageLimits([
              ["secondary", 30],
              ["individual", 100],
            ]),
          }),
          provider("codex_free", 10),
        ],
        current,
        nowMs: NOW,
      }),
    ).toBeNull();
  });
});
