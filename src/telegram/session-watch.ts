import type { ObservedTurn, SessionBridge, TopicStore } from './types.js';

const RELAYED_TURN_LIMIT = 32;
const SENT_PROMPT_LIMIT = 8;

export interface SessionWatch {
  start(): void;
  watch(sessionId: string): void;
  unwatch(sessionId: string): void;
  stopAll(): void;
  markSent(sessionId: string, prompt: string): void;
  markRelayed(sessionId: string, turn: number): void;
}

type SessionWatchDependencies = {
  bridge: SessionBridge;
  store: TopicStore;
  echoTurn: (turn: ObservedTurn) => Promise<void>;
};

export function createSessionWatch({
  bridge,
  store,
  echoTurn,
}: SessionWatchDependencies): SessionWatch {
  const subscriptions = new Map<
    string,
    { active: boolean; unsubscribe: (() => void) | undefined }
  >();
  const relayedTurns = new Map<string, Set<number>>();
  const sentPrompts = new Map<string, string[]>();

  const onTurn = (turn: ObservedTurn): void => {
    const relayed = relayedTurns.get(turn.sessionId);
    if (relayed?.delete(turn.turn)) {
      if (relayed.size === 0) relayedTurns.delete(turn.sessionId);
      return;
    }

    const prompts = sentPrompts.get(turn.sessionId);
    if (prompts !== undefined) {
      const promptIndex = prompts.indexOf(turn.prompt);
      if (promptIndex >= 0) {
        prompts.splice(promptIndex, 1);
        if (prompts.length === 0) sentPrompts.delete(turn.sessionId);
        return;
      }
    }

    void echoTurn(turn).catch(() => undefined);
  };

  const watch = (sessionId: string): void => {
    const existing = subscriptions.get(sessionId);
    if (existing?.active) return;
    const subscription: { active: boolean; unsubscribe: (() => void) | undefined } = {
      active: true,
      unsubscribe: undefined,
    };
    subscriptions.set(sessionId, subscription);
    const onState = (state: string): void => {
      if (state === 'resumable') {
        if (!subscription.active) return;
        subscription.active = false;
        const removeSubscription = subscription.unsubscribe;
        subscription.unsubscribe = undefined;
        removeSubscription?.();
        return;
      }
      if (state === 'live' && !subscription.active) watch(sessionId);
    };
    const unsubscribe = bridge.subscribeSession({
      sessionId,
      fromTail: true,
      onTurn: (turn) => {
        if (subscription.active) onTurn(turn);
      },
      onState,
    });
    if (subscription.active) subscription.unsubscribe = unsubscribe;
    else unsubscribe();
  };

  const unwatch = (sessionId: string): void => {
    const subscription = subscriptions.get(sessionId);
    if (subscription !== undefined) {
      subscription.active = false;
      subscription.unsubscribe?.();
    }
    subscriptions.delete(sessionId);
    relayedTurns.delete(sessionId);
    sentPrompts.delete(sessionId);
  };

  const stopAll = (): void => {
    for (const subscription of subscriptions.values()) {
      subscription.active = false;
      subscription.unsubscribe?.();
    }
    subscriptions.clear();
    relayedTurns.clear();
    sentPrompts.clear();
  };

  const markSent = (sessionId: string, prompt: string): void => {
    const prompts = sentPrompts.get(sessionId) ?? [];
    prompts.push(prompt);
    if (prompts.length > SENT_PROMPT_LIMIT) prompts.shift();
    sentPrompts.set(sessionId, prompts);
  };

  const markRelayed = (sessionId: string, turn: number): void => {
    const turns = relayedTurns.get(sessionId) ?? new Set<number>();
    turns.add(turn);
    while (turns.size > RELAYED_TURN_LIMIT) {
      const oldest = turns.values().next().value as number | undefined;
      if (oldest === undefined) break;
      turns.delete(oldest);
    }
    relayedTurns.set(sessionId, turns);

    const prompts = sentPrompts.get(sessionId);
    if (prompts !== undefined) {
      prompts.shift();
      if (prompts.length === 0) sentPrompts.delete(sessionId);
    }
  };

  const start = (): void => {
    for (const binding of store.all()) watch(binding.sessionId);
  };

  return { start, watch, unwatch, stopAll, markSent, markRelayed };
}
