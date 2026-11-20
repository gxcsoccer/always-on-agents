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
  });
  config.trusted.push("notes");
}
