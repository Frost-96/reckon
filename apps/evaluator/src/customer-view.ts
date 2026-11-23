import type { MessageView } from "./http.ts";

// A text fragment of a model call in progress, as the task API streams it.
export interface DraftEvent {
  turn: number;
  // The seq the call's step will take once the call is complete.
  step: number;
  // The lease version the call runs under; a takeover calls the model again under a new one.
  attempt: number;
  index: number;
  text: string;
}

export type StreamEvent =
  | { event: "draft"; data: DraftEvent }
  | { event: "message"; data: MessageView };

export type DraftFate =
  // A written message of the turn took its place.
  | "replaced"
  // A newer attempt came: the call it belonged to was abandoned.
  | "discarded"
  // The next model call's draft came under the same attempt: this call went on to tools.
  | "superseded"
  // Never shown: an older attempt than one already seen, or a call whose message is already there.
  | "ignored"
  // Still showing when the stream was read to its end.
  | "left";

export interface DraftRecord {
  turn: number;
  step: number;
  attempt: number;
  text: string;
  fate: DraftFate;
}

export interface CustomerView {
  // The written conversation, in order, each message once.
  messages: MessageView[];
  // The draft showing below them, if any.
  draft: DraftRecord | null;
  // Every draft that came, in order of arrival, and what became of it.
  drafts: DraftRecord[];
}

// What a customer following the task's stream sees, by the draft rules: a written message replaces
// the draft, a draft of a newer attempt discards the old one, drafts of older attempts are ignored.
export function viewOf(events: readonly StreamEvent[]): CustomerView {
  const messages = new Map<string, MessageView>();
  const drafts: DraftRecord[] = [];
  let draft: DraftRecord | null = null;
  let latestAttempt = 0;
  // Steps up to the latest agent message are written; a late draft of one is stale.
  let writtenUpTo = 0;
  for (const { event, data } of events) {
    if (event === "message") {
      const key = `${data.turn}:${data.seq}`;
      if (!messages.has(key)) {
        messages.set(key, data);
      }
      if (data.role === "agent") {
        writtenUpTo = Math.max(writtenUpTo, data.seq);
        if (draft !== null && draft.step <= data.seq) {
          draft.fate = "replaced";
          draft = null;
        }
      }
      continue;
    }
    if (data.attempt < latestAttempt || data.step <= writtenUpTo) {
      const ignored = drafts.findLast(
        (record) =>
          record.fate === "ignored" && record.step === data.step && record.attempt === data.attempt,
      );
      if (ignored === undefined) {
        drafts.push({ ...pick(data), fate: "ignored" });
      } else {
        ignored.text += data.text;
      }
      continue;
    }
    latestAttempt = data.attempt;
    if (draft !== null && draft.step === data.step && draft.attempt === data.attempt) {
      draft.text += data.text;
      continue;
    }
    if (draft !== null) {
      draft.fate = data.attempt > draft.attempt ? "discarded" : "superseded";
    }
    draft = { ...pick(data), fate: "left" };
    drafts.push(draft);
  }
  const ordered = [...messages.values()].sort((a, b) => a.turn - b.turn || a.seq - b.seq);
  return { messages: ordered, draft, drafts };
}

function pick({ turn, step, attempt, text }: DraftEvent) {
  return { turn, step, attempt, text };
}
