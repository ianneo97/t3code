/**
 * Moves a new turn to another account of the same provider when the thread's
 * account has used up a quota window, so the turn does not fail on the limit
 * or run on paid credits while another subscription sits unused.
 *
 * Only fresh turns are rerouted. Work that belongs to a run already under way
 * (a steer, a restart, a delegated completion) stays on that run's account.
 *
 * @module LimitAccountSwitch
 */
import {
  resolveProjectProviderInstanceEnabled,
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadShell,
  type ServerProvider,
  type ServerSettings,
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
    command.dispatchMode.type === "restart_active"
  ) {
    return null;
  }
  return selectionAfterExhaustedLimit({
    // The dispatch rejects an account switched off for the thread's project, so it never takes over.
    providers: input.providers.filter((provider) =>
      resolveProjectProviderInstanceEnabled(input.settings, thread.projectId, provider.instanceId),
    ),
    current: command.modelSelection ?? thread.modelSelection,
    nowMs: input.nowMs,
  });
}
