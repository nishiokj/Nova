import {
  controlField,
  events,
  link,
  matchEvent,
  prompt,
} from "prompt-protocol";

// Define a control field to drive a tagged union.
const StepType = controlField("type", ["next", "done", "interrupt"]);

const StepEvents = events();

// A tiny validator that enforces the control field at runtime.
const StepValidator = {
  parse(input) {
    if (typeof input !== "object" || input === null || !StepType.is(input.type)) {
      throw new Error("Invalid StepEvent");
    }
    return input;
  },
};

const decide = prompt({
  id: "decide.v1",
  text: `Return a StepEvent JSON object.

The field "type" must be one of:
${StepType.describe({
  next: "Proceed to the next step",
  done: "Finish and include a summary",
  interrupt: "Stop with a reason",
})}`.trim(),
  output: StepValidator,
  control: StepType,
});

const decisionLink = link(decide, StepEvents, {
  emit: ["next", "done", "interrupt"],
  map: {
    next: () => ({ type: "next" }),
    done: (out) => ({ type: "done", summary: out.summary ?? "" }),
    interrupt: (out) => ({ type: "interrupt", reason: out.reason ?? "" }),
  },
});

// Simulate a prompt output and route it into an event.
const output = decide.parse({ type: "done", summary: "All good." });
const ev = decisionLink.toEvent(output);

const result = matchEvent(StepEvents, ev, {
  next: () => ({ action: "loop" }),
  done: (e) => ({ action: "stop", summary: e.summary }),
  interrupt: (e) => ({ action: "interrupt", reason: e.reason }),
});

console.log({ output, ev, result });
