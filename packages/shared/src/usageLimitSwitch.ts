/**
 * Which other accounts of the same provider can take over when one account
 * has used up a quota window. Shared by the clients, which offer the switch,
 * and the server, which can make it on its own.
 *
 * @module usageLimitSwitch
 */
import {
  resolveProjectProviderInstanceEnabled,
  type ModelSelection,
  type ProjectId,
  type ServerProvider,
  type ServerProviderUsageWindow,
  type ServerSettings,
} from "@t3tools/contracts";

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

export interface LimitSwitchInput<P extends SwitchProvider = SwitchProvider> {
  readonly providers: ReadonlyArray<P>;
  readonly current: ModelSelection;
  /**
   * The thread's project. The dispatch rejects an account switched off there,
   * and the snapshot's `enabled` means "on in any project", so this decides.
   */
  readonly project: {
    readonly settings: Pick<ServerSettings, "providerInstances" | "projectSettingsOverrides">;
    readonly projectId: ProjectId | null;
  };
  readonly nowMs: number;
}

// Spend budgets bill past the plan instead of ending it: Claude's extra-usage
// `monthly_spend` and Codex's `individual` monthly credit limit.
const SPEND_WINDOW_IDS: Readonly<Record<string, true>> = { monthly_spend: true, individual: true };
// Claude's model-scoped weekly windows; the suffix is the model's display name,
// see `scopedWindowId` in apps/server/src/provider/claudeUsageLimits.ts.
const MODEL_SCOPED_WINDOW_PREFIX = "seven_day_";

function nameTokens(value: string): string {
  return `_${value.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_`;
}

/**
 * The windows that can stop a turn of `model` on this account: the plan's own
 * windows, plus a model-scoped window only when it names `model` (`seven_day_fable`
 * limits `claude-fable-5-1`, not `claude-haiku-5-5`).
 */
export function planUsageWindows(
  provider: Pick<ServerProvider, "usageLimits">,
  model: string,
): ReadonlyArray<ServerProviderUsageWindow> {
  // An unsupported account has no windows; a failed probe keeps the ones turns streamed in.
  return (provider.usageLimits?.windows ?? []).filter(
    (window) =>
      SPEND_WINDOW_IDS[window.id] !== true &&
      (!window.id.startsWith(MODEL_SCOPED_WINDOW_PREFIX) ||
        nameTokens(model).includes(`_${window.id.slice(MODEL_SCOPED_WINDOW_PREFIX.length)}_`)),
  );
}

/** The used-up plan window that reopens last, which is the one a turn of `model` waits on. */
export function exhaustedUsageWindow(
  provider: Pick<ServerProvider, "usageLimits">,
  model: string,
  nowMs: number,
): ServerProviderUsageWindow | undefined {
  return planUsageWindows(provider, model)
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

/** Headroom of the tightest plan window for `model`, or null when the account reports none. */
function usageHeadroomPercent(
  provider: Pick<ServerProvider, "usageLimits">,
  model: string,
): number | null {
  const windows = planUsageWindows(provider, model);
  if (windows.length === 0) return null;
  return Math.max(0, 100 - Math.max(...windows.map((window) => window.usedPercent)));
}

export interface LimitSwitchCandidate<P extends SwitchProvider> {
  readonly provider: P;
  readonly selection: ModelSelection;
  /** Headroom of the tightest plan window that limits the selected model. */
  readonly remainingPercent: number;
}

/**
 * Other ready, signed-in instances of the current instance's driver that offer
 * the same model and have room left in the plan limits they report. An account
 * without plan limits (API key, Bedrock) bills per token, so it never takes
 * over. Instances sharing the current one's continuation group come first,
 * since they resume the native thread; after that, the most headroom wins,
 * then the instance id so the order is stable.
 */
export function rankLimitSwitchCandidates<P extends SwitchProvider>(
  input: LimitSwitchInput<P>,
): ReadonlyArray<LimitSwitchCandidate<P>> {
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
      !resolveProjectProviderInstanceEnabled(
        input.project.settings,
        input.project.projectId,
        provider.instanceId,
      )
    ) {
      return [];
    }
    const model = provider.models.find(
      (entry) => entry.slug === input.current.model || entry.aliases?.includes(input.current.model),
    );
    if (!model || exhaustedUsageWindow(provider, model.slug, input.nowMs) !== undefined) return [];
    const remainingPercent = usageHeadroomPercent(provider, model.slug);
    if (remainingPercent === null) return [];
    return [
      {
        sameContinuation:
          source.continuation !== undefined &&
          source.continuation.groupKey === provider.continuation?.groupKey,
        candidate: {
          provider,
          selection: { ...input.current, instanceId: provider.instanceId, model: model.slug },
          remainingPercent,
        } satisfies LimitSwitchCandidate<P>,
      },
    ];
  });
  return [...candidates]
    .sort(
      (left, right) =>
        Number(right.sameContinuation) - Number(left.sameContinuation) ||
        right.candidate.remainingPercent - left.candidate.remainingPercent ||
        left.candidate.provider.instanceId.localeCompare(right.candidate.provider.instanceId),
    )
    .map((entry) => entry.candidate);
}

/**
 * The selection a turn should run on instead of `current`, when `current`'s
 * account has used up a window and another account can take the turn. Null
 * when the account still has allowance or nobody can take over.
 */
export function selectionAfterExhaustedLimit(input: LimitSwitchInput): ModelSelection | null {
  const source = input.providers.find(
    (provider) => provider.instanceId === input.current.instanceId,
  );
  if (!source || exhaustedUsageWindow(source, input.current.model, input.nowMs) === undefined) {
    return null;
  }
  return rankLimitSwitchCandidates(input)[0]?.selection ?? null;
}
