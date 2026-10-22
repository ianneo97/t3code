/**
 * Which other accounts of the same provider can take over a thread that hit a
 * usage limit. Shared by web and mobile so both offer the same targets.
 *
 * @module limitSwitchTargets
 */
import type { ModelSelection, ServerProvider, ServerProviderUsageWindow } from "@t3tools/contracts";

import {
  exhaustedUsageWindow,
  planUsageWindows,
  rankLimitSwitchCandidates,
} from "@t3tools/shared/usageLimitSwitch";

import { resolveProviderInstanceDisplayName } from "./providerInstanceDisplay.ts";

export interface LimitSwitchTarget {
  readonly selection: ModelSelection;
  readonly label: string;
  /** Headroom of the tightest known window, or null when the account reports none. */
  readonly remainingPercent: number | null;
}

/**
 * Other ready, signed-in instances of the current instance's driver that offer
 * the thread's model and are not known to be out of quota, best first. See
 * `rankLimitSwitchCandidates` for the order.
 */
export function listLimitSwitchTargets(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly current: ModelSelection;
  readonly nowMs: number;
}): ReadonlyArray<LimitSwitchTarget> {
  return rankLimitSwitchCandidates(input).map((candidate) => ({
    selection: candidate.selection,
    label: resolveProviderInstanceDisplayName(candidate.provider),
    remainingPercent: candidate.remainingPercent,
  }));
}

/** At or below this headroom the selected account is worth a heads-up. */
const LOW_REMAINING_PERCENT = 10;

export interface LimitSwitchSuggestion {
  readonly sourceLabel: string;
  readonly window: ServerProviderUsageWindow;
  /** Headroom left in `window`; 0 once it is used up. */
  readonly remainingPercent: number;
  readonly targets: ReadonlyArray<LimitSwitchTarget>;
}

/**
 * Set once the selected account is low on, or out of, a window and another
 * account can take over. A provider that keeps running past its allowance, as
 * Codex does on credits, never fails the turn, so the window is the only signal.
 */
export function suggestLimitSwitch(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly current: ModelSelection;
  readonly nowMs: number;
}): LimitSwitchSuggestion | null {
  const source = input.providers.find(
    (provider) => provider.instanceId === input.current.instanceId,
  );
  if (!source) return null;
  const window =
    exhaustedUsageWindow(source, input.current.model, input.nowMs) ??
    planUsageWindows(source, input.current.model)
      .filter(
        (candidate) =>
          100 - candidate.usedPercent <= LOW_REMAINING_PERCENT &&
          (candidate.resetsAt === undefined || Date.parse(candidate.resetsAt) > input.nowMs),
      )
      .reduce<ServerProviderUsageWindow | undefined>(
        (tightest, candidate) =>
          tightest === undefined || candidate.usedPercent > tightest.usedPercent
            ? candidate
            : tightest,
        undefined,
      );
  if (!window) return null;
  const targets = listLimitSwitchTargets(input);
  return targets.length === 0
    ? null
    : {
        sourceLabel: resolveProviderInstanceDisplayName(source),
        window,
        remainingPercent: Math.max(0, 100 - window.usedPercent),
        targets,
      };
}
