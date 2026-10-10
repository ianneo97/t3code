/**
 * Which other accounts of the same provider can take over a thread that hit a
 * usage limit. Shared by web and mobile so both offer the same targets.
 *
 * @module limitSwitchTargets
 */
import type { ModelSelection, ServerProvider, ServerProviderUsageWindow } from "@t3tools/contracts";

import { resolveProviderInstanceDisplayName } from "./providerInstanceDisplay.ts";

export interface LimitSwitchTarget {
  readonly selection: ModelSelection;
  readonly label: string;
  /** Headroom of the tightest known window, or null when the account reports none. */
  readonly remainingPercent: number | null;
}

function remainingPercent(provider: ServerProvider): number | null {
  const usage = provider.usageLimits;
  if (!usage || usage.unavailable || usage.windows.length === 0) return null;
  return Math.max(0, 100 - Math.max(...usage.windows.map((window) => window.usedPercent)));
}

/** The used-up window that reopens last, which is the one the account is waiting on. */
function exhaustedWindow(
  provider: ServerProvider,
  nowMs: number,
): ServerProviderUsageWindow | undefined {
  return provider.usageLimits?.windows
    .filter(
      (window) =>
        window.usedPercent >= 100 &&
        (window.resetsAt === undefined || Date.parse(window.resetsAt) > nowMs),
    )
    .reduce<ServerProviderUsageWindow | undefined>(
      (latest, window) =>
        latest === undefined ||
        Date.parse(window.resetsAt ?? "") > Date.parse(latest.resetsAt ?? "") ||
        window.resetsAt === undefined
          ? window
          : latest,
      undefined,
    );
}

function isExhausted(provider: ServerProvider, nowMs: number): boolean {
  return exhaustedWindow(provider, nowMs) !== undefined;
}

/**
 * Other ready, signed-in instances of the current instance's driver that offer
 * the thread's model and are not known to be out of quota. Instances sharing the
 * thread's continuation group come first, since they resume the native thread;
 * after that, the most headroom wins.
 */
export function listLimitSwitchTargets(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly current: ModelSelection;
  readonly nowMs: number;
}): ReadonlyArray<LimitSwitchTarget> {
  const source = input.providers.find(
    (provider) => provider.instanceId === input.current.instanceId,
  );
  if (!source) return [];
  const candidates = input.providers.flatMap((provider) => {
    if (
      provider.instanceId === source.instanceId ||
      provider.driver !== source.driver ||
      !provider.enabled ||
      !provider.installed ||
      provider.availability === "unavailable" ||
      provider.status !== "ready" ||
      provider.auth.status !== "authenticated" ||
      isExhausted(provider, input.nowMs)
    ) {
      return [];
    }
    const model = provider.models.find(
      (entry) => entry.slug === input.current.model || entry.aliases?.includes(input.current.model),
    );
    if (!model) return [];
    const sameContinuation =
      source.continuation !== undefined &&
      source.continuation.groupKey === provider.continuation?.groupKey;
    return [
      {
        sameContinuation,
        target: {
          selection: { ...input.current, instanceId: provider.instanceId, model: model.slug },
          label: resolveProviderInstanceDisplayName(provider),
          remainingPercent: remainingPercent(provider),
        } satisfies LimitSwitchTarget,
      },
    ];
  });
  return [...candidates]
    .sort(
      (left, right) =>
        Number(right.sameContinuation) - Number(left.sameContinuation) ||
        (right.target.remainingPercent ?? -1) - (left.target.remainingPercent ?? -1) ||
        left.target.label.localeCompare(right.target.label),
    )
    .map((candidate) => candidate.target);
}

export interface LimitSwitchSuggestion {
  readonly sourceLabel: string;
  readonly window: ServerProviderUsageWindow;
  readonly targets: ReadonlyArray<LimitSwitchTarget>;
}

/**
 * Set once the selected account has used up a window and another account can
 * take over. A provider that keeps running past its allowance, as Codex does on
 * credits, never fails the turn, so the window is the only signal.
 */
export function suggestLimitSwitch(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly current: ModelSelection;
  readonly nowMs: number;
}): LimitSwitchSuggestion | null {
  const source = input.providers.find(
    (provider) => provider.instanceId === input.current.instanceId,
  );
  const window = source ? exhaustedWindow(source, input.nowMs) : undefined;
  if (!source || !window) return null;
  const targets = listLimitSwitchTargets(input);
  return targets.length === 0
    ? null
    : { sourceLabel: resolveProviderInstanceDisplayName(source), window, targets };
}
