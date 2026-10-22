import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";

import {
  limitAccountSwitchSelection,
  queuedRunLimitSwitchSelection,
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
  return { dispatchMode: { type: "start_immediately" }, creationSource: "web", ...overrides };
}

const PROJECT = ProjectId.make("project:test");
const idle = { projectId: PROJECT, modelSelection: usedUp, activeRunId: null };
const settings = {
  providerInstances: {
    [ProviderInstanceId.make("codex_personal")]: { driver: ProviderDriverKind.make("codex") },
    [ProviderInstanceId.make("codex_work")]: { driver: ProviderDriverKind.make("codex") },
  },
  projectSettingsOverrides: {},
};

describe("limitAccountSwitchSelection", () => {
  it("moves a fresh turn off the used-up account, whether the selection came with the message or from the thread", () => {
    expect(
      limitAccountSwitchSelection({
        command: command(),
        thread: idle,
        settings,
        providers,
        nowMs: NOW,
      }),
    ).toEqual({ instanceId: "codex_personal", model: "gpt-6" });
    expect(
      limitAccountSwitchSelection({
        command: command({ modelSelection: usedUp }),
        thread: { ...idle, modelSelection: { ...usedUp, instanceId: providers[1]!.instanceId } },
        settings,
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
        settings,
        providers,
        nowMs: NOW,
      }),
    ).toBeNull();
  });

  it("leaves work alone that belongs to a run already under way", () => {
    const runId = RunId.make("run:test");
    const cases: ReadonlyArray<Partial<LimitAccountSwitchCommand>> = [
      { dispatchMode: { type: "steer_active", targetRunId: runId } },
      { dispatchMode: { type: "restart_active", targetRunId: runId } },
      { deliveryIntent: "steer" },
      { restartContinuationOfRunId: runId },
      { delegatedCompletion: { parentRunId: runId, generation: 1, taskIds: [] } },
    ];
    for (const overrides of cases) {
      expect(
        limitAccountSwitchSelection({
          command: command(overrides),
          thread: idle,
          settings,
          providers,
          nowMs: NOW,
        }),
      ).toBeNull();
    }
  });

  it("decides a message queued behind a run when it starts, not when it is queued", () => {
    const snapshot = { settings, providers, nowMs: NOW };
    expect(
      limitAccountSwitchSelection({
        ...snapshot,
        command: command({ dispatchMode: { type: "queue_after_active" } }),
        thread: { ...idle, activeRunId: RunId.make("run:active") },
      }),
    ).toBeNull();
    expect(
      queuedRunLimitSwitchSelection({
        ...snapshot,
        run: {},
        creationSource: "web",
        current: usedUp,
        projectId: PROJECT,
      }),
    ).toEqual({ instanceId: "codex_personal", model: "gpt-6" });
    const runId = RunId.make("run:test");
    const keptOnTheirAccount: ReadonlyArray<
      Pick<Parameters<typeof queuedRunLimitSwitchSelection>[0], "run" | "creationSource">
    > = [
      { run: { restartContinuationOfRunId: runId }, creationSource: "web" },
      {
        run: { delegatedCompletion: { disposition: "open", nextGeneration: 1, delivery: null } },
        creationSource: "server",
      },
      { run: {}, creationSource: "provider" },
    ];
    for (const queued of keptOnTheirAccount) {
      expect(
        queuedRunLimitSwitchSelection({
          ...snapshot,
          ...queued,
          current: usedUp,
          projectId: PROJECT,
        }),
      ).toBeNull();
    }
  });

  it("keeps a provider wake-up on its account, since only that session holds the buffered output", () => {
    const wake = { dispatchMode: { type: "queue_after_active" } } as const;
    expect(
      limitAccountSwitchSelection({
        command: command({ ...wake, creationSource: "provider" }),
        thread: idle,
        settings,
        providers,
        nowMs: NOW,
      }),
    ).toBeNull();
    // A plain-text wake carries no buffered output, so it is an ordinary fresh turn.
    expect(
      limitAccountSwitchSelection({
        command: command({ ...wake, creationSource: "server" }),
        thread: idle,
        settings,
        providers,
        nowMs: NOW,
      }),
    ).toEqual({ instanceId: "codex_personal", model: "gpt-6" });
  });

  it("never hands the turn to an account switched off for the thread's project", () => {
    expect(
      limitAccountSwitchSelection({
        command: command(),
        thread: idle,
        settings: {
          ...settings,
          projectSettingsOverrides: {
            [PROJECT]: {
              providerInstances: {
                [ProviderInstanceId.make("codex_personal")]: { enabled: false },
              },
            },
          },
        },
        providers: [...providers, provider("codex_work", 60)],
        nowMs: NOW,
      }),
    ).toEqual({ instanceId: "codex_work", model: "gpt-6" });
  });
});
