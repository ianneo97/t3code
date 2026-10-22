/**
 * Moves a new turn to another account of the same provider when the thread's
 * account has used up a quota window, so the turn does not fail on the limit
 * or run on paid credits while another subscription sits unused.
 *
 * Only fresh turns are rerouted: a message sent to an idle thread, and a queued
 * message when it starts. Work that belongs to a run already under way (a
 * steer, a restart, a delegated completion) stays on that run's account, and so
 * does a provider wake-up: it delivers output buffered in that account's CLI
 * session, which another account does not have.
 *
 * @module LimitAccountSwitch
 */
import type {
  ModelSelection,
  OrchestrationV2Command,
  OrchestrationV2CreationSource,
  OrchestrationV2Run,
  OrchestrationV2ThreadShell,
  ProjectId,
  ServerProvider,
  ServerSettings,
} from "@t3tools/contracts";
import { selectionAfterExhaustedLimit } from "@t3tools/shared/usageLimitSwitch";

/** What the server knows about its accounts when a turn starts. */
interface LimitSnapshot {
  readonly settings: Pick<ServerSettings, "providerInstances" | "projectSettingsOverrides">;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly nowMs: number;
}

/** The parts of a message dispatch that decide whether its turn may be rerouted. */
export type LimitAccountSwitchCommand = Pick<
  Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>,
  | "modelSelection"
  | "delegatedCompletion"
  | "restartContinuationOfRunId"
  | "deliveryIntent"
  | "dispatchMode"
  | "creationSource"
>;

/** Null when the command should be dispatched as it came. */
export function limitAccountSwitchSelection(
  input: LimitSnapshot & {
    readonly command: LimitAccountSwitchCommand;
    readonly thread: Pick<
      OrchestrationV2ThreadShell,
      "projectId" | "modelSelection" | "activeRunId"
    >;
  },
): ModelSelection | null {
  const { command, thread } = input;
  if (
    // Queued behind the active run; `queuedRunLimitSwitchSelection` decides when it starts.
    thread.activeRunId !== null ||
    command.delegatedCompletion !== undefined ||
    command.restartContinuationOfRunId !== undefined ||
    command.deliveryIntent === "steer" ||
    command.deliveryIntent === "restart" ||
    command.dispatchMode.type === "steer_active" ||
    command.dispatchMode.type === "restart_active" ||
    command.creationSource === "provider"
  ) {
    return null;
  }
  return selectionAfterExhaustedLimit({
    providers: input.providers,
    current: command.modelSelection ?? thread.modelSelection,
    project: { settings: input.settings, projectId: thread.projectId },
    nowMs: input.nowMs,
  });
}

/**
 * The account a queued run starts on instead of `current`, the one it was
 * queued with; null to keep that. Decided at start, since the account may have
 * run out while the run waited.
 */
export function queuedRunLimitSwitchSelection(
  input: LimitSnapshot & {
    readonly run: Pick<OrchestrationV2Run, "delegatedCompletion" | "restartContinuationOfRunId">;
    /** Of the run's user message; undefined when the message is gone. */
    readonly creationSource: OrchestrationV2CreationSource | undefined;
    readonly current: ModelSelection;
    readonly projectId: ProjectId;
  },
): ModelSelection | null {
  if (
    input.run.delegatedCompletion !== undefined ||
    input.run.restartContinuationOfRunId !== undefined ||
    input.creationSource === "provider"
  ) {
    return null;
  }
  return selectionAfterExhaustedLimit({
    providers: input.providers,
    current: input.current,
    project: { settings: input.settings, projectId: input.projectId },
    nowMs: input.nowMs,
  });
}
