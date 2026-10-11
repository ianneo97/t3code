/**
 * Which other accounts of the same provider can take over when one account
 * has used up a quota window. Shared by the clients, which offer the switch,
 * and the server, which can make it on its own.
 *
 * @module usageLimitSwitch
 */
import type { ModelSelection, ServerProvider, ServerProviderUsageWindow } from "@t3tools/contracts";

type SwitchProvider = Pick<
  ServerProvider,
  | "instanceId"
  | "driver"
  | "enabled"
  | "installed"
  | "availability"
  | "status"
  | "auth"
  | "models"
  | "continuation"
  | "usageLimits"
>;

/** The used-up window that reopens last, which is the one the account is waiting on. */
export function exhaustedUsageWindow(
  provider: Pick<ServerProvider, "usageLimits">,
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

/** Headroom of the tightest known window, or null when the account reports none. */
function usageHeadroomPercent(provider: Pick<ServerProvider, "usageLimits">): number | null {
  const usage = provider.usageLimits;
  if (!usage || usage.unavailable || usage.windows.length === 0) return null;
  return Math.max(0, 100 - Math.max(...usage.windows.map((window) => window.usedPercent)));
}

export interface LimitSwitchCandidate<P extends SwitchProvider> {
  readonly provider: P;
  readonly selection: ModelSelection;
  readonly remainingPercent: number | null;
}

/**
 * Other ready, signed-in instances of the current instance's driver that offer
 * the same model and are not known to be out of quota. Instances sharing the
 * current one's continuation group come first, since they resume the native
 * thread; after that, the most headroom wins, then the instance id so the
 * order is stable.
 */
export function rankLimitSwitchCandidates<P extends SwitchProvider>(input: {
  readonly providers: ReadonlyArray<P>;
  readonly current: ModelSelection;
  readonly nowMs: number;
}): ReadonlyArray<LimitSwitchCandidate<P>> {
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
      exhaustedUsageWindow(provider, input.nowMs) !== undefined
    ) {
      return [];
    }
    const model = provider.models.find(
      (entry) => entry.slug === input.current.model || entry.aliases?.includes(input.current.model),
    );
    if (!model) return [];
    return [
      {
        sameContinuation:
          source.continuation !== undefined &&
          source.continuation.groupKey === provider.continuation?.groupKey,
        candidate: {
          provider,
          selection: { ...input.current, instanceId: provider.instanceId, model: model.slug },
          remainingPercent: usageHeadroomPercent(provider),
        } satisfies LimitSwitchCandidate<P>,
      },
    ];
  });
  return [...candidates]
    .sort(
      (left, right) =>
        Number(right.sameContinuation) - Number(left.sameContinuation) ||
        (right.candidate.remainingPercent ?? -1) - (left.candidate.remainingPercent ?? -1) ||
        left.candidate.provider.instanceId.localeCompare(right.candidate.provider.instanceId),
    )
    .map((entry) => entry.candidate);
}

/**
 * The selection a turn should run on instead of `current`, when `current`'s
 * account has used up a window and another account can take the turn. Null
 * when the account still has allowance or nobody can take over.
 */
export function selectionAfterExhaustedLimit(input: {
  readonly providers: ReadonlyArray<SwitchProvider>;
  readonly current: ModelSelection;
  readonly nowMs: number;
}): ModelSelection | null {
  const source = input.providers.find(
    (provider) => provider.instanceId === input.current.instanceId,
  );
  if (!source || exhaustedUsageWindow(source, input.nowMs) === undefined) return null;
  return rankLimitSwitchCandidates(input)[0]?.selection ?? null;
}
