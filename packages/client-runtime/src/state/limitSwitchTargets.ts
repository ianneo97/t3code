/**
 * Which other accounts of the same provider can take over a thread that hit a
 * usage limit. Shared by web and mobile so both offer the same targets.
 *
 * @module limitSwitchTargets
 */
import type { ModelSelection, ServerProvider } from "@t3tools/contracts";

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

function isExhausted(provider: ServerProvider, nowMs: number): boolean {
  return (
    provider.usageLimits?.windows.some(
      (window) =>
        window.usedPercent >= 100 &&
        (window.resetsAt === undefined || Date.parse(window.resetsAt) > nowMs),
    ) ?? false
  );
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
