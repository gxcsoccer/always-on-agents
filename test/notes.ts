/**
 * A connector for tests: a place where people's messages can be edited, and which can be asked
 * again what a message says. It is added to the deployment's configuration before anything reads
 * it, so the Brain treats it as it would any connector listed there.
 *
 * `notes` is what the place holds now. A test that writes a message with a subject records it here
 * (see `message` in helpers.ts); one that wants the place to have forgotten a message deletes it.
 */
import config from "../src/agent.config";
import { DeliveryDeferred, type Standing } from "../src/connectors/types";

export const notes: Map<string, Standing> = ((globalThis as any).__notes ??= new Map());
/** Pages by "<person>/<name>", and every read that was made of them. */
export const pages: Map<string, string> = ((globalThis as any).__pages ??= new Map());
export const reads: { person: string; origin: Record<string, string>; page: string }[] = ((globalThis as any).__reads ??= []);

if (!config.connectors.some((connector) => connector.name === "notes")) {
  config.connectors.push({
    name: "notes",
    channel: {
      async deliver() {
        // A test can have the place ask not to be tried again for a while.
        const wait = (globalThis as any).__notesWaitMs as number | undefined;
        if (wait) throw new DeliveryDeferred("asked to wait", Date.now() + wait);
      },
      async standing(_env, _scope, subject) {
        return notes.get(subject);
      },
    },
    // A tool for tests: reads a page that a test put in `pages`, for whoever the run acts for.
    tools: [
      {
        name: "notes_read",
        description: "Read one of the person's pages.",
        effect: "read",
        parameters: { page: { type: "string" } },
        async run(context, args) {
          reads.push({ person: context.person, origin: context.origin, page: String(args.page) });
          const text = pages.get(`${context.person}/${String(args.page)}`);
          if (text === undefined) throw new Error("no such page for this person");
          return { text };
        },
      },
    ],
  });
  config.trusted.push("notes");
}
