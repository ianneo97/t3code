/**
 * Moves a new turn to another account of the same provider when the thread's
 * account has used up a quota window, so the turn does not fail on the limit
 * or run on paid credits while another subscription sits unused.
 *
 * Only fresh turns are rerouted. Work that belongs to a run already under way
 * (a steer, a restart, a delegated completion) stays on that run's account, and
 * so does a provider wake-up: it delivers output buffered in that account's
 * CLI session, which another account does not have.
 *
 * @module LimitAccountSwitch
 */
import type {
  ModelSelection,
  OrchestrationV2Command,
  OrchestrationV2ThreadShell,
  ServerProvider,
  ServerSettings,
} from "@t3tools/contracts";
import { selectionAfterExhaustedLimit } from "@t3tools/shared/usageLimitSwitch";

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
export function limitAccountSwitchSelection(input: {
  readonly command: LimitAccountSwitchCommand;
  readonly thread: Pick<OrchestrationV2ThreadShell, "projectId" | "modelSelection" | "activeRunId">;
  readonly settings: Pick<ServerSettings, "providerInstances" | "projectSettingsOverrides">;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly nowMs: number;
}): ModelSelection | null {
  const { command, thread } = input;
  if (
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
