import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const driver = ProviderDriverKind.make("codex");
const usedUp = ProviderInstanceId.make("codex");
const spare = ProviderInstanceId.make("codex_spare");
const on = (instanceId: ProviderInstanceId): ModelSelection => ({ instanceId, model: "gpt-6" });

function provider(instanceId: ProviderInstanceId, weeklyUsed: number): ServerProvider {
  return {
    instanceId,
    driver,
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
          // Far enough ahead that the test clock never passes it.
          resetsAt: "2999-01-01T00:00:00.000Z",
        },
      ],
    },
  };
}

type Started = { readonly instanceId: ProviderInstanceId; readonly text: string };

function makeAdapter(
  instanceId: ProviderInstanceId,
  cwd: string,
  started: Array<Started>,
  events: Queue.Queue<ProviderAdapter.ProviderAdapterV2Event>,
): ProviderAdapter.ProviderAdapterV2["Service"] {
  const capabilities = CodexProviderCapabilitiesV2;
  return {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        return {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd,
            model: "gpt-6",
            capabilities,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: ({ threadId }) =>
            Effect.succeed({
              id: ProviderThreadId.make(`provider-thread:${instanceId}:${threadId}`),
              driver,
              providerInstanceId: instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: `native:${instanceId}`, strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turn) =>
            Effect.gen(function* () {
              started.push({ instanceId, text: turn.message.text });
              yield* Queue.offer(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: {
                  id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                  providerThreadId: turn.providerThread.id,
                  nodeId: turn.rootNodeId,
                  runAttemptId: turn.attemptId,
                  nativeTurnRef: {
                    driver,
                    nativeId: `native:${turn.attemptId}`,
                    strength: "strong",
                  },
                  ordinal: turn.providerTurnOrdinal,
                  status: "running",
                  startedAt: now,
                  completedAt: null,
                },
              });
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: () => Effect.die("unused"),
        };
      }),
  };
}

/**
 * Two Codex accounts, `usedUp` and `spare`, behind the real orchestrator and
 * thread management service. `providers` is what the registry reports; tests
 * change it to model limits moving.
 */
const switchHarness = Effect.fn("switchHarness")(function* (input: {
  readonly name: string;
  readonly switchAccountAtUsageLimit: boolean;
}) {
  const cwd = yield* checkpointWorkspace(input.name);
  const started: Array<Started> = [];
  const providers = yield* Ref.make([provider(usedUp, 100), provider(spare, 20)]);
  const adapters = yield* Effect.forEach([usedUp, spare], (instanceId) =>
    Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>().pipe(
      Effect.map((events) => makeAdapter(instanceId, cwd, started, events)),
    ),
  );
  const layerProviderRegistry = Layer.mock(ProviderRegistry.ProviderRegistry)({
    getProviders: Ref.get(providers),
  });
  const layer = ThreadManagementService.layer.pipe(
    Layer.provide(layerProviderRegistry),
    Layer.provideMerge(
      ProviderReplayHarness.layerWithRegistry(
        { name: input.name },
        ProviderAdapterRegistry.layerFromAdapters(adapters),
        {
          runEffectWorker: false,
          serverSettings: {
            switchAccountAtUsageLimit: input.switchAccountAtUsageLimit,
            providerInstances: { [usedUp]: { driver }, [spare]: { driver } },
          },
          providerRegistry: layerProviderRegistry,
        },
      ),
    ),
  );
  const createThread = (selection: ModelSelection) =>
    Orchestrator.OrchestratorV2.use((orchestrator) =>
      orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create"),
        threadId: ThreadId.make(`thread:${input.name}`),
        projectId: ProjectId.make(`project:${input.name}`),
        title: "Usage-limit switch",
        modelSelection: selection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: cwd,
        createdBy: "user",
        creationSource: "web",
      }),
    ).pipe(Effect.as(ThreadId.make(`thread:${input.name}`)));
  return { started, providers, layer, createThread };
});

/**
 * Runs a first turn on `firstOn`, queues a message pinned to the used-up
 * account behind it, ends the first turn with `firstOutcome`, then starts the
 * queued message. Returns the accounts each turn started on and the thread's
 * account afterwards.
 */
const runQueuedBehindFirstTurn = Effect.fn("runQueuedBehindFirstTurn")(function* (input: {
  readonly name: string;
  readonly switchAccountAtUsageLimit: boolean;
  readonly firstOn: ProviderInstanceId;
  readonly firstOutcome: "completed" | "cancelled";
}) {
  const { started, layer, createThread } = yield* switchHarness(input);
  return yield* Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const sink = yield* EventSink.EventSinkV2;
    const threadId = yield* createThread(on(input.firstOn));
    const running = yield* orchestrator.streamDomainEvents.pipe(
      Stream.filter(
        (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
      ),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkScoped,
    );
    // Straight to the orchestrator: the first turn runs where it is told.
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("first"),
      threadId,
      messageId: MessageId.make("message:first"),
      text: "first",
      attachments: [],
      modelSelection: on(input.firstOn),
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* worker.drain();
    yield* Fiber.join(running);
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("queued"),
      threadId,
      messageId: MessageId.make("message:queued"),
      text: "queued",
      attachments: [],
      modelSelection: on(usedUp),
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
    });
    const before = yield* orchestrator.getThreadProjection(threadId);
    const queued = before.runs.find((run) => run.status === "queued");
    if (queued === undefined) return yield* Effect.die("the message was not queued");
    assert.equal(queued.providerInstanceId, usedUp);
    const now = yield* DateTime.now;
    // End the first turn and hold the queue, so the start below is the only one.
    yield* sink.write({
      events: [
        ...before.runs.map((run) => ({
          id: EventId.make(`end:${run.id}`),
          type: "run.updated" as const,
          threadId,
          runId: run.id,
          occurredAt: now,
          payload:
            run.status === "queued"
              ? { ...run, queueHeld: true }
              : { ...run, status: input.firstOutcome, completedAt: now },
        })),
        ...before.providerTurns.map((turn) => ({
          id: EventId.make(`end:${turn.id}`),
          type: "provider-turn.updated" as const,
          threadId,
          occurredAt: now,
          payload: { ...turn, status: input.firstOutcome, completedAt: now },
        })),
      ],
    });
    yield* orchestrator.dispatch({
      type: "queued-run.start",
      commandId: CommandId.make("start-queued"),
      threadId,
      runId: queued.id,
    });
    yield* worker.drain();
    const after = yield* orchestrator.getThreadProjection(threadId);
    return {
      started,
      queuedRun: after.runs.find((run) => run.id === queued.id),
      threadInstance: after.thread.modelSelection.instanceId,
    };
  }).pipe(Effect.provide(layer));
});

it.effect("starts a queued message on another account when its own has used up a limit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const result = yield* runQueuedBehindFirstTurn({
        name: "queued-limit-switch-on",
        switchAccountAtUsageLimit: true,
        firstOn: usedUp,
        firstOutcome: "cancelled",
      });
      assert.deepEqual(result.started, [
        { instanceId: usedUp, text: "first" },
        { instanceId: spare, text: "queued" },
      ]);
      assert.equal(result.queuedRun?.providerInstanceId, spare);
      assert.equal(result.threadInstance, spare);
    }),
  ),
);

it.effect("starts a queued message on its own account while the switch is off", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const result = yield* runQueuedBehindFirstTurn({
        name: "queued-limit-switch-off",
        switchAccountAtUsageLimit: false,
        firstOn: usedUp,
        firstOutcome: "cancelled",
      });
      assert.deepEqual(result.started, [
        { instanceId: usedUp, text: "first" },
        { instanceId: usedUp, text: "queued" },
      ]);
      assert.equal(result.threadInstance, usedUp);
    }),
  ),
);

it.effect(
  "keeps the thread on the account that took over when a message queued on the used-up one starts",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const result = yield* runQueuedBehindFirstTurn({
          name: "queued-limit-switch-no-flip-back",
          switchAccountAtUsageLimit: true,
          firstOn: spare,
          firstOutcome: "completed",
        });
        assert.deepEqual(result.started, [
          { instanceId: spare, text: "first" },
          { instanceId: spare, text: "queued" },
        ]);
        assert.equal(result.threadInstance, spare);
      }),
    ),
);

const freshTurn = (threadId: ThreadId) =>
  ({
    type: "message.dispatch",
    commandId: CommandId.make("fresh"),
    threadId,
    messageId: MessageId.make("message:fresh"),
    text: "fresh",
    attachments: [],
    modelSelection: on(usedUp),
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  }) as const;

it.effect.each([
  { switchAccountAtUsageLimit: true, startsOn: spare },
  { switchAccountAtUsageLimit: false, startsOn: usedUp },
])(
  "hands a fresh turn on a used-up account to the orchestrator on the account that takes over (switch on: $switchAccountAtUsageLimit)",
  ({ switchAccountAtUsageLimit, startsOn }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { started, layer, createThread } = yield* switchHarness({
          name: `fresh-turn-limit-switch-${switchAccountAtUsageLimit ? "on" : "off"}`,
          switchAccountAtUsageLimit,
        });
        yield* Effect.gen(function* () {
          const threads = yield* ThreadManagementService.ThreadManagementService;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = yield* createThread(on(usedUp));
          yield* threads.dispatch(freshTurn(threadId));
          yield* worker.drain();
          const after = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(started, [{ instanceId: startsOn, text: "fresh" }]);
          assert.equal(after.runs[0]?.providerInstanceId, startsOn);
          assert.equal(after.thread.modelSelection.instanceId, startsOn);
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect("replays a retried fresh turn's first result even after the limits moved", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, providers, layer, createThread } = yield* switchHarness({
        name: "fresh-turn-limit-switch-retry",
        switchAccountAtUsageLimit: true,
      });
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagementService.ThreadManagementService;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* createThread(on(usedUp));
        const first = yield* threads.dispatch(freshTurn(threadId));
        yield* worker.drain();
        // Now the switch would leave the retry where it was sent.
        yield* Ref.set(providers, [provider(usedUp, 10), provider(spare, 100)]);
        const retried = yield* threads.dispatch(freshTurn(threadId));
        yield* worker.drain();
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(retried, first);
        assert.deepEqual(started, [{ instanceId: spare, text: "fresh" }]);
        assert.lengthOf(after.runs, 1);
        assert.equal(after.thread.modelSelection.instanceId, spare);
      }).pipe(Effect.provide(layer));
    }),
  ),
);
