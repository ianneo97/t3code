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
});
