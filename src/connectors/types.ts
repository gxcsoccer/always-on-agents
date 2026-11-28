/**
 * What a connector is.
 *
 * A connector joins the agent to one outside system. It is a plain object listed in
 * `src/agent.config.ts`; everything the rest of the code knows about an outside system it learns
 * through this interface. A connector contributes any of these, each on its own:
 *
 *   - `http`:      requests under /v1/<name>/…, such as the system's webhooks
 *   - `admin`:     the operator's requests for setting it up
 *   - `scheduled`: work to do every minute, such as keeping a connection open
 *   - `channel`:   delivering the agent's messages to a conversation in that system
 *   - `tools`:     things the agent can do in that system on one person's behalf
 *
 * A connector that only reports events (a CI notifier, say) has `http` and nothing else.
 *
 * What a connector may not decide. It says who caused an event; whether that person's word counts
 * is decided by the Brain, and only for connectors the deployment lists as trusted (see
 * `agent.config.ts`). A connector outside that list can inform the agent and nothing more.
 *
 * What this interface does not do. Connectors are first-party code compiled into the Worker: each
 * one is handed the whole environment and writes its own name on the events it hands over. The
 * trusted list therefore guards against a connector being relied on by oversight, not against one
 * that misstates where its events came from. Review a connector as you would any code that holds
 * the deployment's secrets.
 */
import type { Env } from "../env";
import type { InboundEvent, Principal, Scope, Target } from "../events";

export interface Connector {
  /** Lowercase; also the first path segment of its routes and the `source` of its events. */
  name: string;
  /**
   * Whether an event of this connector's that waits is still to be taken up, asked just before
   * anything is spent on it: of a kind of event the deployment may have stopped wanting since it
   * arrived. One that is not is dropped, and nothing is done about it.
   */
  wanted?(env: Env, event: { kind: string }): boolean;
  /** Handles a request under /v1/<name>/. `path` is what follows the name. */
  http?(request: Request, env: Env, path: string[], ingress: Ingress): Promise<Response>;
  /** Handles an admin request it owns, already authenticated. Returns undefined for any other. */
  admin?(request: AdminRequest, env: Env): Promise<Response | undefined>;
  /** Called every minute. */
  scheduled?(env: Env): Promise<void>;
  channel?: Channel;
  /** Named `<connector name>_…`. See ConnectorTool for when they are offered. */
  tools?: ConnectorTool[];
  /**
   * Required of a connector whose tools can answer "not yet" (see Waiting). Says whether a
   * condition one of its tools named holds now, checked afresh against whatever the connector
   * itself keeps: never against what a caller says. `since` is when it began to hold, by the
   * connector's own record. "gone" means it can no longer come to hold as it was asked for.
   * Throws if that cannot be found out right now. A connector that plugs into another (`serves`)
   * is asked first, and answers nothing (undefined) for a condition that is not its own.
   */
  holds?(env: Env, scope: Scope, condition: string, generation: number): Promise<Holds | undefined>;
  /**
   * The names of other connectors whose people this connector's tools are also for. A connector
   * that plugs in like this need have no way in or out of its own: a person reaches the agent
   * through the other connector, which says who they are, and this one adds something the agent
   * can do for them. Its tools are offered wherever that connector's own would be.
   */
  serves?: string[];
  /**
   * What to put before a person for one of this connector's `Waiting.interaction`s, made at the
   * moment of sending: words and one link, for whichever channel shows it. Null once it can no
   * longer be used; undefined for an interaction that is not this connector's.
   */
  invitation?(env: Env, interaction: string): Promise<Invitation | null | undefined>;
  /**
   * For a connector that plugs into another: which of its `optional` tools are for the person
   * who caused this event of that connector's, as the operator has set things up. Asked once,
   * as the event arrives; what it answers is kept with the event (`data.offered`), and nothing
   * a connector writes there itself is believed.
   */
  offers?(env: Env, event: InboundEvent): Promise<string[]>;
}

/**
 * `again_in_ms`: with "not yet", how long until it is worth asking again, for something nobody
 * will come and report (a reply being written elsewhere, say). Without it, it is asked again
 * only when something is reported or the wait runs out.
 *
 * `refused`: with "gone", the person went the way they were shown and it did not go through, so
 * what they asked for was not done. They are told so, once for each way in.
 */
export type Holds = { state: "holds"; since: number } | { state: "not_yet"; again_in_ms?: number } | { state: "gone"; refused?: true };

/**
 * A few characters that stand for one way in: said where a person is told that it was sent to
 * them somewhere else, and shown on the way in itself, so that they can tell which goes with
 * which. Made from the reference alone, the same every time; it gives nothing away and opens nothing.
 */
export function markOf(interaction: string): string {
  let hash = 2166136261;
  for (let index = 0; index < interaction.length; index++) hash = Math.imul(hash ^ interaction.charCodeAt(index), 16777619) >>> 0;
  // No 0/O, 1/I/L: read back without doubt.
  const letters = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  let mark = "";
  for (let index = 0; index < 4; index++, hash = Math.floor(hash / letters.length)) mark += letters[hash % letters.length];
  return mark;
}

/** Something to put before a person so that they can bring a condition about: what it is, and the one place to go. */
export interface Invitation {
  title: string;
  text: string;
  action: { label: string; url: string };
  note?: string;
}

/**
 * A tool's answer when it cannot act until something happens that is not the agent's to do (the
 * person authorising, say). The Brain keeps the request and carries it on once the condition
 * holds; the tool is then called again with the same `callId`. All of these are the connector's
 * own strings, which the Brain stores and hands back without reading:
 *   subject     - whose condition it is; a report that "something changed for this subject"
 *                 (see BrainAgent.conditionReported) makes the Brain ask `holds` again
 *   condition   - what exactly has to hold for this request
 *   generation  - `holds` answers "gone" once the connector has moved past it
 *   until       - the condition has to have come to hold before this, in ms
 *   request     - the call to make again when the condition holds, in the tool's own canonical
 *                 form: only what identifies the thing asked for. The Brain stores this, never
 *                 the arguments the model wrote
 *   interaction - what to put in front of the person so that they can bring it about. The Brain
 *                 sends it through the conversation's channel, which turns it into something to
 *                 look at only at the moment of sending (see OutboundMessage.interaction)
 */
export interface Waiting {
  waiting: {
    on: string;
    subject: string;
    condition: string;
    generation: number;
    until: number;
    /** Absent where there is nothing for the person to do: what is waited for happens by itself. */
    interaction?: string;
    /**
     * For a tool that hands work to a worker: set where the work has already been handed over, or
     * may have been, and what is waited for is only the way to its result. Left out only where it
     * is certain that nothing was handed over yet.
     */
    handed?: true;
    request: Record<string, unknown>;
    /**
     * The way in is for the person alone: it is put before them directly, not where the request
     * was made (a conversation several people share is not the place for it). The tool only says
     * so. Where "directly" is, the connector's channel works out from where the request
     * verifiably came and who made it (`channel.direct`); the tool names no address. The
     * conversation the request was made in is told only how that went, once it is known.
     *
     * "here": for the person alone all the same, but where they asked if the channel can show
     * something there to one person only (`channel.aside`); directly otherwise. It is never put
     * where the others would see it.
     */
    privately?: boolean | "here";
  };
}

/**
 * What a tool returns when the matter ends here: nothing was read, nothing waits, and nothing
 * more is to be done about it in this run, by the model or by anything else. If something is to
 * be said to the person, the system says it: `say` names one of its own fixed lines (the tool
 * writes no words of its own here), and without it nothing is said.
 */
export interface Settled {
  settled: { say?: string };
}

/** Whether a tool's answer is that and nothing else. Whether `say` names a line there is, is the Brain's to check. */
export function isSettled(result: unknown): result is Settled {
  if (typeof result !== "object" || result === null || Object.keys(result).some((key) => key !== "settled")) return false;
  const s = (result as Settled).settled;
  return typeof s === "object" && s !== null && !Array.isArray(s) && Object.keys(s).every((key) => key === "say") && (s.say === undefined || (typeof s.say === "string" && s.say !== ""));
}

export function isWaiting(result: unknown): result is Waiting {
  const w = (result as Waiting | null)?.waiting;
  return typeof w === "object" && w !== null && [w.on, w.subject, w.condition].every((each) => typeof each === "string" && each !== "") && (w.interaction === undefined || (typeof w.interaction === "string" && w.interaction !== "")) && Number.isFinite(w.generation) && Number.isFinite(w.until) && typeof w.request === "object" && w.request !== null && (w.privately === undefined || typeof w.privately === "boolean" || w.privately === "here");
}

/**
 * Something the agent can do in an outside system for one person, as that person.
 *
 * A connector's tools are offered only where it is beyond doubt whose authority a call carries:
 * in a person's own private conversation, in a run started by nothing but that person's own
 * messages, all of which arrived through this connector with the same verified origin. The Brain
 * decides this; the model cannot choose whom a tool acts for, and neither can the tool's
 * arguments.
 *
 * What a tool returns comes from outside and may be written by anyone, and what the model goes on
 * to say carries it. The Brain treats it so: from the first such call on, the run can only reply
 * to the person and read again; and when the run ends everything it produced is removed from the
 * conversation's record, leaving a note that something was read.
 *
 * A tool call may be repeated after an interruption, so a tool must be safe to run twice.
 *
 * A tool that cannot act yet because the person has not authorised it answers with a Waiting.
 * It sends nothing itself: what the person is shown goes out through the Brain, like everything
 * else said to them.
 */
export interface ConnectorTool {
  name: string;
  description: string;
  /**
   * What the tool does to the outside system. "read": it looks and changes nothing. "act": it
   * does something there as the person (starts something, sends something). Once a run has read
   * outside text, reading again is the only thing a connector's tool may still do in it: an
   * "act" tool can no longer be used, so nothing that was read can have something done.
   */
  effect: "read" | "act";
  /** Offered only where its connector said so for the very messages a run acts on (see `Connector.offers`): not there at all otherwise. */
  optional?: true;
  /**
   * Set on a tool that hands a piece of work to a worker: the worker's name. A request such a
   * tool keeps waiting is then recorded as a piece of work, under the request's id.
   */
  hands_to?: string;
  /**
   * Whether the tool may also be used where several people talk (a group, say), for the one of
   * them who asked. Without it the tool exists only in a person's private conversation. A tool
   * that says so answers for what that takes: what it reads there is said in front of the others.
   */
  shared?: boolean;
  /**
   * That this tool may be named, when work is handed over, as what is to be done in the person's
   * name once the work has ended well. Only for a tool that does its one thing once for a call id,
   * however often it is called with it, and says so again rather than doing it again.
   */
  follows?: boolean;
  /**
   * Conditions it can be named to follow under, by name, each with what it means (said to the
   * model when work is handed over). Named as tool:condition, the tool is called with
   * `after.only_if` and holds itself to it, by what the work's host counted and not by what the
   * worker says.
   */
  conditions?: Record<string, string>;
  /** JSON Schema properties. Every one is required; use a nullable type for an optional value. */
  parameters: Record<string, unknown>;
  run(context: ToolContext, args: Record<string, unknown>): Promise<unknown>;
  /**
   * Whether one of the person's own messages links the thing one of this tool's canonical calls
   * (as it identified a read) names. Lets the Brain tell, without knowing the tool, which of the
   * things an earlier answer was written from the person can still point at.
   */
  /**
   * `kept`: the messages are the ones kept for a request that is being carried on, to be taken as
   * they were taken when it was made (time that has passed since does not make them say less).
   */
  links?(message: { text: string; data: Record<string, unknown> }, request: Record<string, unknown>, kept?: boolean): boolean;
}

/**
 * A tool's result may carry `aside`: what the tool says about the thing it read, as against what
 * it read from it (what could not be read, whether a look-up of its structure worked). The model
 * is given it like the rest. It is left out when a result is compared with an earlier one to
 * tell whether the thing has changed.
 */
export interface ToolResultAside {
  aside?: Record<string, unknown>;
}

/**
 * A tool's result may carry `direct`: words for the person alone (a link the others where they
 * asked may not be able to follow, say). The Brain takes it out of what the model is given and
 * sends it to the person directly, through the connector their request came through, once for
 * the call however often it is made. The tool names no address.
 */
export interface ToolResultDirect {
  direct?: { text: string };
}

export interface ToolContext {
  env: Env;
  scope: Scope;
  /** The one person this run acts for, as the connector identified them. */
  person: string;
  /** What the connector verified about where that person's messages came from. */
  origin: Record<string, string>;
  /**
   * The person's messages that started this run, as the connector handed them over: the text, and
   * the `data` the connector attached. A tool can hold a call to what the person themselves asked
   * for, whatever the model was led to ask.
   */
  said: { text: string; data: Record<string, unknown> }[];
  /**
   * What the same person wrote in this private conversation before (their messages over the last
   * day, at most fifty), by the same test as `said` and in the same form. A link in one message
   * and "summarise it", or a question about it later, are one request to a person. These are
   * their own messages as they arrived; nothing a run wrote or read is among them.
   */
  recent: { text: string; data: Record<string, unknown> }[];
  /**
   * Set when the person's message replies to one of the agent's own answers in this conversation,
   * as it reached them. `source`: the one thing that answer (or every answer replied to) was
   * written from that the person linked themselves among `said` and `recent`, as this tool's
   * canonical call; absent when there is no such single thing (written from nothing read, from
   * several, or from one no longer in reach), in which case nothing is to be read on its strength.
   * `nothing`: every answer replied to was written without anything being read. Such an answer
   * points at nothing, so the reply is as any other message of the person's.
   */
  answering?: { source?: Record<string, unknown>; nothing?: true };
  /** Names this call; the same on a repeat, and the same when a request that waited is carried on. */
  callId: string;
  /**
   * Set when this call carries on a request that waited (see Waiting). The call is good only
   * for the generation the request waited on and only until `notAfter`: if the connector has
   * moved past that generation, or the time is up, the tool must do nothing and say so. It must
   * not start the request over under a newer generation.
   */
  resuming?: { generation: number; notAfter: number };
  /**
   * Set when the call is made after a piece of work the person's request handed over has ended
   * well, as that request said it might be: what it acts on may be what the work found, not only
   * what the person wrote. `said` and `recent` are still the person's own messages, the ones
   * the request was made in.
   */
  after?: {
    work: string;
    /** What the work was given to work on (for the sandbox: the repository), as the Brain gave it; none where it was given none. */
    on?: string;
    /** When what follows the work is no longer to be done: counted from when the work ended, however often the call is made. */
    until: number;
    /** What the worker's host itself counted of what the work did (not what the worker says of it), as it came with the result. */
    seen?: Record<string, unknown>;
    /** The condition it was named to follow under (one of the tool's own `conditions`), if any. */
    only_if?: string;
    /** This very call has had its end before: nothing is to be done again, only said of it what is still kept (to whoever may be told now). */
    done?: true;
  };
  /**
   * To be called by a tool for each of the person's messages its action actually rests on: the
   * one in `said` that names the thing, or the one in `recent` (by its index there) when the
   * tool acts on that rather than on what was just said ("summarise it" after a link). The
   * Brain keeps the earlier message as part of what the request rests on, and takes a reply to
   * any of these messages, and to no other, as being about this request.
   */
  relied?(from: "said" | "recent", index: number): void;
  /**
   * To be called by a tool that has read something, before it returns: the call that would read
   * the same thing again, in the tool's own canonical form, and a name for the very thing that
   * was read as the outside system resolved it (a link can come to point elsewhere). Kept by the
   * Brain so that an answer can later be tied to what it was read from.
   */
  /**
   * `under` names the condition the read was made under, in the same terms as a Waiting's
   * (`condition`, `generation`): what `holds` can be asked about later. With it, what was read
   * goes no further (to the model, to the channel) once that no longer holds.
   */
  identified?(request: Record<string, unknown>, identity: string, under: { condition: string; generation: number }): void;
  /**
   * For a tool that hands work to a worker (`hands_to`): to be called with how the piece of work
   * of this call stands, as far as the tool knows it, whenever it has taken the work or has
   * learnt how it ended: "open", or how it ended ("unknown" where it cannot be told whether the
   * worker took it). Not called where nothing was handed over at all. This is the work's own
   * outcome, whatever the person is told of it.
   */
  work?(as: "open" | "done" | "failed" | "cancelled" | "expired" | "void" | "unknown"): void;
}

export interface Ingress {
  /** Keeps the invocation alive for work that continues after the response. */
  defer(work: Promise<unknown>): void;
}

export interface AdminRequest {
  method: string;
  /** The path after /v1/admin/. */
  path: string[];
  url: URL;
  /** The JSON body, or {} when there is none. */
  body(): Promise<Record<string, any>>;
}

/** What a place shows of a message sent to it (see `Channel.shows`). */
export interface Shows {
  /** The words are shown as Markdown (headings, lists, emphasis, code); otherwise as the plain text they are. */
  markdown: boolean;
  /** People named with the message are reminded of it there. */
  reminds: boolean;
}

export interface Channel {
  /**
   * Sends one message. Throwing means "not delivered, try again later"; it must be safe to repeat
   * (see `idem`). A channel with `standing` must return a Receipt for an approval question: a
   * question posted where it can be changed, and not identifiable there, cannot be approved.
   */
  deliver(env: Env, scope: Scope, target: Target, message: OutboundMessage): Promise<Receipt | void>;
  /**
   * Marks a delivered approval question as closed where it is shown, if the system can: the
   * question stops inviting an answer and says how it ended. Best effort; nothing depends on it.
   */
  amend?(env: Env, target: Target, receipt: Receipt, ask: ApprovalQuestion, outcome: Outcome): Promise<void>;
  /**
   * Shows a delivered invitation as over where it is shown, once nothing waits on it any more:
   * it stops offering its way in and says whether it was used ("used") or can no longer be
   * ("over"). An invitation of the channel's own that can still be used is left as it is (the
   * next request may be shown the same one): resolves to whether it was shown as over. Best
   * effort; nothing depends on it.
   */
  closeInvitation?(env: Env, target: Target, receipt: Receipt, interaction: string, how: "used" | "over"): Promise<boolean>;
  /**
   * Required of a system where what was said can be changed afterwards (edited or deleted). Says
   * what a message says now, so that an approval is never acted on unseen. Such a connector gives
   * its events a `subject`, a `revision` and a `holder`; this is asked about that subject before
   * any approval read from it counts. It throws if the system cannot be asked. Returns undefined
   * only for a subject that is not this connector's in this scope.
   *
   * A connector whose events carry a subject but which has no `standing` cannot carry approvals:
   * the Brain refuses them.
   */
  standing?(env: Env, scope: Scope, subject: string): Promise<Standing | undefined>;
  /**
   * Shows the person, on the very message they wrote, that it has arrived: a reaction, say. It
   * is a sign, not a message: it may fail, repeat or come late without anything depending on it,
   * and it must never add a message to the conversation. Called once per message a person
   * addressed to the agent, as soon as the message is stored; nothing waits for it.
   */
  /**
   * `wanted` is asked last of all, just before anything is posted: it says no once the sign
   * would come too late to mean anything (the message has been dealt with, or time has passed).
   * Resolves to an opaque mark for the sign (a reaction's id, say), only when the outside system
   * confirmed it; undefined when there was nothing to mark or it was skipped. The Brain keeps the
   * mark and hands it to `unreceived` once the message has been dealt with.
   */
  received?(env: Env, scope: Scope, event: { source_id: string; data?: Record<string, unknown>; reply_to?: Target; wanted(): boolean }): Promise<string | undefined>;
  /**
   * Takes off a mark `received` put on a message, once the message has been dealt with. `mark` is
   * what `received` returned. "removed" also when it was already gone; "retry" when the outside
   * system could not say (busy, unreachable); "permanent" when it will not be taken off.
   */
  unreceived?(env: Env, scope: Scope, event: { data?: Record<string, unknown>; reply_to?: Target }, mark: string): Promise<"removed" | "retry" | "permanent">;
  /**
   * Where a person is reached directly through this connector (their own chat with the bot, say),
   * worked out from a verified origin and their id, and from nothing else. Undefined where they
   * cannot be.
   */
  direct?(origin: Record<string, string>, person: string): Target | undefined;
  /**
   * An address in the conversation `from` points into at which only this one person sees what is
   * sent, worked out from a verified origin, their id and that address. Undefined where the
   * channel has no such thing.
   */
  aside?(origin: Record<string, string>, person: string, from: Target): Target | undefined;
  /**
   * What a message sent to this address comes to there, as a few fixed answers: whether its words
   * are shown as Markdown, and whether it can remind people (see `OutboundMessage.mention`). The
   * Brain tells the model so in words of its own: a connector writes nothing into the prompt, and
   * nothing a conversation or a platform said goes into these answers. Without it, the model is
   * told nothing of the place.
   */
  shows?(scope: Scope, target: Target): Shows;
  /**
   * The message something sent to this address is written under, named as a message's
   * `data.replies_to` names it; undefined where it is under nothing. From the address alone.
   */
  under?(target: Target): string | undefined;
  /**
   * The message this one was written in reply to, where the Brain was never sent it (a group
   * sends the agent only what mentions it). Asked once, before the run that takes the message
   * up, with a limit on how long it may take; nothing depends on it. Its words are given only
   * when the same person wrote it; otherwise only that there was one. Undefined where this does
   * not apply. `signal` fires when the answer is no longer waited for.
   */
  quoted?(env: Env, scope: Scope, event: { principal: Principal; data?: Record<string, unknown>; signal?: AbortSignal }): Promise<Quoted | undefined>;
  /**
   * Fetches pictures people sent, by the names this connector itself put in a message's
   * `data.pictures` (or a quoted message's `pictures`). `event` is the message the run acts on:
   * it says through what the pictures are asked for. Each comes back in its place, or null
   * where it cannot be had (gone, too large, not a picture). Never throws for one picture.
   */
  pictures?(env: Env, scope: Scope, event: { data?: Record<string, unknown> }, refs: PictureRef[]): Promise<(Picture | null)[]>;
  /**
   * For how long the outside system drops a repeat of the same `idem`. A message whose first
   * attempt is older than this and was never confirmed is not sent again: it may have arrived,
   * and a second copy could no longer be told from the first. It can depend on the address: 0
   * for one where a repeat is never dropped, so an attempt whose outcome is unknown is the last.
   */
  dedupeMs?: number | ((target: Target) => number);
}

/**
 * Thrown by `deliver` when the outside system said not to try again before a certain time. The
 * message is retried as after any failure, but no sooner than that.
 */
export class DeliveryDeferred extends Error {
  constructor(
    message: string,
    /** In ms since the epoch. */
    readonly notBefore: number,
  ) {
    super(message);
    this.name = "DeliveryDeferred";
  }
}

/**
 * Thrown by `deliver` when the outside system answered and refused the message: it is certain
 * that nothing was posted. Any other failure leaves that open.
 */
export class DeliveryRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryRejected";
  }
}

/**
 * Thrown by `deliver` when there is no longer anything to send (what the message was to show
 * can no longer be used). Nothing was posted, and it is not tried again.
 */
export class DeliveryVoid extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryVoid";
  }
}

/** Where a revisable message stands at its source right now. */
export type Standing = { revision: number; holder: string; deleted: boolean; edited: boolean };

export interface OutboundMessage {
  id: number;
  /** Stable across retries, so a connector can avoid sending the same message twice. */
  idem: string;
  text: string;
  /**
   * The agent's own words (written by the model), as against the system's fixed words. A channel
   * that can render formatting may render these; fixed words are plain.
   */
  authored?: boolean;
  /**
   * Which encoding to send it with, fixed at its first attempt so that every retry sends the very
   * same thing under the same `idem`: 0 for the encoding before connectors could choose one (a
   * message whose sending began then), 1 for the first a connector chose by, 2 for the one under
   * which a connector may put the words right as it writes them out, 3 for the current one, under
   * which it may also put its mention of someone where the words name them. A connector sends a
   * message of an earlier encoding as it would have then.
   */
  encoding?: number;
  /** When the message was written, in ms. */
  created_at?: number;
  /**
   * The people this message is to remind, by their ids on this connector: decided by the Brain
   * (see Reminders) and fixed when the message was kept. A channel that can mention people does
   * so in its own way; whatever in `text` looks like a mention is only text.
   */
  mention?: string[];
  /**
   * For some of them, the name the one who asked wrote for the person (as the connector gave it
   * when the message came). A channel may put its mention where the words name the person by it,
   * and not a second time before them.
   */
  mention_names?: Record<string, string>;
  /**
   * Set when the message is an approval question. `text` says the same in words; a connector that
   * can show something better than text (buttons, say) builds it from this.
   */
  ask?: ApprovalQuestion;
  /**
   * Set when the message is a code review. `text` says the same in words (the summary, then each
   * comment with its file and line); a connector that can attach comments to lines builds them
   * from this.
   */
  review?: CodeReview;
  /**
   * A Waiting's `interaction`, for the connector that made it to turn into what the person is
   * shown. Whatever it stands for (a link that authorises, say) exists only inside the connector
   * and in the message as sent; the Brain never holds it. A channel that does not know the
   * reference sends `text`.
   */
  interaction?: string;
  /** What a connector that plugs into this channel's connector says to show for that interaction, if it is one of its own. */
  invitation?: Invitation;
}

export interface CodeReview {
  summary: string;
  /** The commit that was reviewed, if known. Lines are only meaningful against it. */
  commit?: string;
  comments: { path: string; line: number; body: string }[];
}

export interface ApprovalQuestion {
  /** Names this one question for good, across scopes. A code is unique only within its scope. */
  id: string;
  code: string;
  /** The task's title. */
  title: string;
  kind: "command" | "push";
  /** The command, or what would be pushed where. Shown literally. */
  detail: string;
  /** False when the action is too long to show in full: it can then only be refused. */
  can_approve: boolean;
  /** For a push: where to, and which refs would move from which commit to which. */
  resource?: string;
  refs?: { ref: string; old: string; new: string }[];
  /** Whether the person may also approve the same kind of action for the rest of the task. */
  standing_offered?: boolean;
}

/**
 * Where a delivered message now lives, if it is somewhere other people can change it: the subject
 * names it and the holder is the fingerprint of the text as it was posted.
 */
export interface Receipt {
  subject: string;
  holder: string;
  /** When it was actually posted, if that was on an earlier attempt than the one that confirmed it. */
  posted_at?: number;
}

/** How an approval question ended. */
export type Outcome =
  | { state: "approved" | "refused"; by?: string; standing?: boolean }
  | { state: "withdrawn" }
  /** An answer was sent and it can no longer be found out whether it took effect. */
  | { state: "unknown" };

/** A picture in a message, named so that the connector it came through can fetch it: never the picture itself. */
export interface PictureRef {
  /** The message it is in, as the outside system names it. */
  message: string;
  /** The picture, as the outside system names it within that message. */
  key: string;
}

/** A picture as fetched: what kind it is, and its bytes in base64. Held for the run it is shown in and never kept. */
export interface Picture {
  mime: string;
  data: string;
}

/**
 * A message another was written in reply to: its words where they could be read and are the
 * person's own, or another member's of the same organisation (`other`); empty when there was one
 * that is not shown.
 */
export interface Quoted {
  text?: string;
  /**
   * Set where the words are not the person's own but another member's, of the same organisation,
   * in the same conversation: what the person points at by replying to it. Shown to the model as
   * material, never as a request; and only for the message replied to itself, not further up.
   */
  other?: true;
  /** What that message links, as the connector records it for any message (see a message's `data.documents`). */
  documents?: unknown[];
  /** The pictures in that message, as the connector records them for any message (see a message's `data.pictures`). */
  pictures?: PictureRef[];
  /** When that message was written, in milliseconds, where the outside system says. */
  at?: number;
  /**
   * What that message was itself written in reply to, named as a message's `data.replies_to`
   * names it. Also given, alone, for a message that is not the person's own: nothing of what it
   * says, only where it points, so the chain of replies can be followed past it.
   */
  replies_to?: string;
}
