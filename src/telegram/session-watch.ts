import type { ObservedAsk, ObservedTurn, SessionBridge, TopicStore } from './types.js';
import { askId } from './ask-watch.js';

const RELAYED_TURN_LIMIT = 32;
const SENT_PROMPT_LIMIT = 8;
const SEEN_ASK_LIMIT = 32;

export interface SessionWatch {
  start(): void;
  watch(sessionId: string): void;
  unwatch(sessionId: string): void;
  stopAll(): void;
  markSent(sessionId: string, prompt: string): void;
  markRelayed(sessionId: string, turn: number): void;
  markAsked(sessionId: string, askKey: string): void;
}

type SessionWatchDependencies = {
  bridge: SessionBridge;
  store: TopicStore;
  echoTurn: (turn: ObservedTurn) => Promise<void>;
  echoAsk?: (ask: ObservedAsk) => Promise<void>;
};

export function createSessionWatch({
  bridge,
  store,
  echoTurn,
  echoAsk,
}: SessionWatchDependencies): SessionWatch {
  const subscriptions = new Map<
    string,
    { active: boolean; unsubscribe: (() => void) | undefined }
  >();
  const relayedTurns = new Map<string, Set<number>>();
  const sentPrompts = new Map<string, string[]>();
  const seenAsks = new Map<string, Set<string>>();

  const rememberAsk = (sessionId: string, askKey: string): void => {
    const seen = seenAsks.get(sessionId) ?? new Set<string>();
    seen.add(askKey);
    while (seen.size > SEEN_ASK_LIMIT) {
      const oldest = seen.values().next().value as string | undefined;
      if (oldest === undefined) break;
      seen.delete(oldest);
    }
    seenAsks.set(sessionId, seen);
  };

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

  const onAsk = (ask: ObservedAsk): void => {
    const key = askId(ask.payload);
    if (seenAsks.get(ask.sessionId)?.has(key)) return;
    rememberAsk(ask.sessionId, key);
    if (echoAsk === undefined) return;
    void echoAsk(ask).catch(() => undefined);
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
      onAsk: (ask) => {
        if (subscription.active) onAsk(ask);
      },
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
    seenAsks.delete(sessionId);
  };

  const stopAll = (): void => {
    for (const subscription of subscriptions.values()) {
      subscription.active = false;
      subscription.unsubscribe?.();
    }
    subscriptions.clear();
    relayedTurns.clear();
    sentPrompts.clear();
    seenAsks.clear();
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
  const markAsked = (sessionId: string, askKey: string): void => {
    rememberAsk(sessionId, askKey);
  };

  const start = (): void => {
    for (const binding of store.all()) watch(binding.sessionId);
  };

  return { start, watch, unwatch, stopAll, markSent, markRelayed, markAsked };
}
