import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";

import {
  limitAccountSwitchSelection,
  type LimitAccountSwitchCommand,
} from "./LimitAccountSwitch.ts";

const NOW = Date.parse("2026-10-10T12:00:00.000Z");

function provider(instanceId: string, weeklyUsed: number): ServerProvider {
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
    usageLimits: {
      checkedAt: "2026-10-10T11:59:00.000Z",
      windows: [
        {
          id: "secondary",
          kind: "weekly",
          label: "Weekly",
          usedPercent: weeklyUsed,
          resetsAt: "2026-10-14T02:00:00.000Z",
        },
      ],
    },
  };
}

const usedUp: ModelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6" };
const providers = [provider("codex", 100), provider("codex_personal", 20)];

function command(overrides: Partial<LimitAccountSwitchCommand> = {}): LimitAccountSwitchCommand {
  return { dispatchMode: { type: "start_immediately" }, ...overrides };
}

const idle = { modelSelection: usedUp, activeRunId: null };

describe("limitAccountSwitchSelection", () => {
  it("moves a fresh turn off the used-up account, whether the selection came with the message or from the thread", () => {
    expect(
      limitAccountSwitchSelection({ command: command(), thread: idle, providers, nowMs: NOW }),
    ).toEqual({ instanceId: "codex_personal", model: "gpt-6" });
    expect(
      limitAccountSwitchSelection({
        command: command({ modelSelection: usedUp }),
        thread: { ...idle, modelSelection: { ...usedUp, instanceId: providers[1]!.instanceId } },
        providers,
        nowMs: NOW,
      }),
    ).toEqual({ instanceId: "codex_personal", model: "gpt-6" });
  });

  it("leaves a turn alone when the message already targets an account with allowance", () => {
    expect(
      limitAccountSwitchSelection({
        command: command({
          modelSelection: { ...usedUp, instanceId: providers[1]!.instanceId },
        }),
        thread: idle,
        providers,
        nowMs: NOW,
      }),
    ).toBeNull();
  });

  it("leaves work alone that belongs to a run already under way", () => {
    const runId = RunId.make("run:test");
    const cases: ReadonlyArray<[Partial<LimitAccountSwitchCommand>, RunId | null]> = [
      [{}, runId],
      [{ dispatchMode: { type: "steer_active", targetRunId: runId } }, null],
      [{ dispatchMode: { type: "restart_active", targetRunId: runId } }, null],
      [{ deliveryIntent: "steer" }, null],
      [{ restartContinuationOfRunId: runId }, null],
      [{ delegatedCompletion: { parentRunId: runId, generation: 1, taskIds: [] } }, null],
    ];
    for (const [overrides, activeRunId] of cases) {
      expect(
        limitAccountSwitchSelection({
          command: command(overrides),
          thread: { ...idle, activeRunId },
          providers,
          nowMs: NOW,
        }),
      ).toBeNull();
    }
  });
});
