import {
  type OrchestrationV2LimitRecovery,
  type OrchestrationV2LimitRecoveryUpdate,
  type RunId,
} from "@t3tools/contracts";
import type {
  LimitSwitchSuggestion,
  LimitSwitchTarget,
} from "@t3tools/client-runtime/state/limit-switch-targets";
import { GaugeIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

type RecoveryProps = {
  runId: RunId;
  resetAt: string | null;
  stoppedAt: string;
  snoozedUntil: string | null;
  recovery: OrchestrationV2LimitRecovery | null;
  onChange: (recovery: OrchestrationV2LimitRecoveryUpdate) => Promise<void>;
  /** Other accounts that can take this thread over now; see `listLimitSwitchTargets`. */
  switchTargets: ReadonlyArray<LimitSwitchTarget>;
  onSwitch: (target: LimitSwitchTarget) => Promise<void>;
};

export function usageLimitRecoveryBannerItem(props: RecoveryProps): ComposerBannerStackItem {
  const { runId, resetAt, stoppedAt } = props;
  const canSchedule = resetAt !== null && Date.parse(resetAt) > Date.parse(stoppedAt);
  return {
    id: `usage-limit-recovery:${runId}`,
    variant: "warning",
    priority: "urgent",
    icon: <GaugeIcon />,
    title: "Usage limit reached",
    description: resetAt
      ? `Resets ${new Date(resetAt).toLocaleString()}`
      : "Reset time unavailable; retry manually",
    actions:
      canSchedule || props.switchTargets.length > 0 ? (
        <RecoveryActions key={`${runId}:${resetAt}`} canSchedule={canSchedule} {...props} />
      ) : null,
  };
}

function switchTargetLabel(verb: string, target: LimitSwitchTarget): string {
  const left =
    target.remainingPercent === null ? "" : ` (${Math.round(target.remainingPercent)}% left)`;
  return `${verb} ${target.label}${left}`;
}

/**
 * Shown before any turn fails: the selected account is low on, or out of, a
 * window, and a provider that keeps going past its allowance would never say so.
 */
export function limitSwitchBannerItem(
  suggestion: LimitSwitchSuggestion,
  onSwitch: (target: LimitSwitchTarget) => void,
  onDismiss: (id: string) => void,
): ComposerBannerStackItem {
  const { window, sourceLabel, targets, remainingPercent } = suggestion;
  const usedUp = remainingPercent <= 0;
  // The level is part of the id, so dismissing the heads-up does not hide "used up".
  const id = `usage-window:${usedUp ? "used-up" : "low"}:${sourceLabel}:${window.id}:${window.resetsAt ?? ""}`;
  return {
    id,
    variant: usedUp ? "warning" : "info",
    priority: "notice",
    icon: <GaugeIcon />,
    title: usedUp
      ? `${window.label} limit used up on ${sourceLabel}`
      : `${window.label} limit: ${Math.round(remainingPercent)}% left on ${sourceLabel}`,
    description: window.resetsAt
      ? `Resets ${new Date(window.resetsAt).toLocaleString()}`
      : undefined,
    actions: (
      <div className="flex flex-wrap items-center gap-2">
        {targets.map((target) => (
          <Button
            key={target.selection.instanceId}
            size="xs"
            variant="ghost"
            onClick={() => onSwitch(target)}
          >
            {switchTargetLabel("Switch to", target)}
          </Button>
        ))}
      </div>
    ),
    dismissLabel: "Dismiss usage limit notice",
    onDismiss: () => onDismiss(id),
  };
}

function RecoveryActions({
  runId,
  resetAt,
  recovery,
  snoozedUntil,
  onChange,
  switchTargets,
  onSwitch,
  canSchedule,
}: RecoveryProps & { canSchedule: boolean }) {
  const [pending, setPending] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const delay = Date.parse(resetAt ?? "") - Math.max(nowMs, Date.now());
    if (!Number.isFinite(delay) || delay <= 0) return;
    const timer = window.setTimeout(() => setNowMs(Date.now()), Math.min(delay + 1, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [resetAt, nowMs]);

  const scheduled =
    recovery?.runId === runId && recovery.resetAt === resetAt && recovery.autoResume;
  const snoozed =
    recovery?.snooze === true &&
    recovery.runId === runId &&
    recovery.resetAt === resetAt &&
    resetAt !== null &&
    snoozedUntil !== null &&
    Date.parse(snoozedUntil) === Date.parse(resetAt);
  async function run(change: () => Promise<void>, title: string) {
    setPending(true);
    try {
      await change();
    } catch (cause) {
      toastManager.add({
        type: "error",
        title,
        description: cause instanceof Error ? cause.message : "An error occurred.",
      });
    }
    setPending(false);
  }
  async function toggle(action: "resume" | "snooze") {
    if (resetAt === null) return;
    if (action === "snooze" && !snoozed && Date.parse(resetAt) <= Date.now()) {
      toastManager.add({
        type: "error",
        title: "Could not snooze thread",
        description: "The reset time has passed. Retry the thread manually.",
      });
      setNowMs(Date.now());
      return;
    }
    await run(
      () =>
        onChange({
          runId,
          resetAt,
          ...(action === "resume" ? { autoResume: !scheduled } : { snooze: !snoozed }),
        }),
      action === "resume" ? "Could not change auto-resume" : "Could not snooze thread",
    );
  }
  // Failures go to a toast: the actions column is auto-sized, so inline error
  // text would widen it and crush the title.
  return (
    <>
      {switchTargets.map((target) => (
        <Button
          key={target.selection.instanceId}
          size="xs"
          variant="ghost"
          disabled={pending}
          onClick={() =>
            void run(() => onSwitch(target), `Could not continue with ${target.label}`)
          }
        >
          {switchTargetLabel("Continue with", target)}
        </Button>
      ))}
      {canSchedule ? (
        <Button size="xs" variant="ghost" disabled={pending} onClick={() => void toggle("resume")}>
          {pending ? "Saving..." : scheduled ? "Cancel auto-resume" : "Resume at reset"}
        </Button>
      ) : null}
      {canSchedule && !snoozed ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={pending || Date.parse(resetAt!) <= nowMs}
          onClick={() => void toggle("snooze")}
        >
          {pending ? "Saving..." : "Snooze until reset"}
        </Button>
      ) : null}
    </>
  );
}
