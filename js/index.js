import { reactive } from "../js/arrow.js";
import { createMachine, reduce, state, transition, interpret, immediate, } from "../js/robot3/machine.js";
import "../js/robot3/debug.js";
import { commandConsoleInterpreter, createCommandConsoleTemplate, } from "./command-console/index.js";
import { reduceWithKeys, doThenElse, createSwitchState, guardKeyZero, reduceSetKeyValue, } from "./robot-utils.js";

// Terminal constants
// View IDs
const TERMINAL_ID = "terminal";
const PROMPT_ID = "terminal-input";
const TERMINAL_OUTPUT_ID = "terminal-output";

// Initial Context / Store
const initialTerminalContext = {
    terminalInput: null,
    console: null,
    input: "",
    interpreter: commandConsoleInterpreter,
    output: [],
    history: [],
    historyIndex: 0,
    data: null,
    next: null,
    error: null,
    test: "Init",
    debug: false,
};

// ArrowJS reactive store
const store = reactive(initialTerminalContext);
const evalOutput = (prevOutput, newOutput, next = null, error = null) => ({
    output: [...prevOutput, newOutput],
    next,
    error,
});
const handleEvalResult = (ctx, result) => {
    const timestamp = result?.timestamp?.toLocaleString() ?? new Date().toLocaleString();
    const display = result?.message ?? result;
    if (typeof result === "string") {
        return evalOutput(ctx.output, { display, type: "output", timestamp });
    }
    else if (typeof result === "object") {
        if (result.next === "error") {
            return evalOutput(ctx.output, { display, type: "error", timestamp }, result.next, display);
        }
        else {
            return evalOutput(ctx.output, { display, type: "output", timestamp }, result.next);
        }
    }
};
// Invocation functions
const terminalActivation = async (ctx) => {
    console.log("Mount Terminal to DOM");
    consoleTemplate(document.body);
    return {
        test: "Default Terminal Active",
        terminalInput: document.getElementById(PROMPT_ID),
        console: document.getElementById(TERMINAL_OUTPUT_ID),
    };
};
const terminalDeactivation = async (ctx) => {
    console.log("Unmount Terminal from DOM");
    document.body.removeChild(document.getElementById(TERMINAL_ID));
    return { terminalInput: null, console: null };
};
const terminalEvaluation = async (ctx) => {
    console.log(`Reading input: ${ctx.input}`, ctx);
    const [message, ...args] = ctx.input.split(" ");
    console.log("Evaluating console command:", message, args);
    ctx.output.push({ display: ctx.input, type: "command" });
    ctx.history.push(ctx.input);
    try {
        let result = ctx.interpreter(message, ...args);
        console.log("command result:", result);
        if (result instanceof Promise) {
            result = await result;
        }
        return handleEvalResult(ctx, result);
    }
    catch (error) {
        console.error("interpreter error", error);
        throw error;
    }
};
const scrollTerminalBottom = ({ console }) => () => console && (console.scrollTop = console.scrollHeight);
const inputFocusing = async (ctx) => {
    console.log("focus input", ctx.terminalInput);
    if (ctx.terminalInput)
        ctx.terminalInput.focus();
    setTimeout(scrollTerminalBottom(ctx), 10);
};
const inputClearing = async (ctx) => {
    if (ctx.terminalInput)
        ctx.terminalInput.value = "";
    return { input: "" };
};
const errorTerminal = async (ctx) => {
    if (ctx.terminalInput !== null) {
        if (ctx.error)
            ctx.output.push({ display: ctx.error, type: "error" });
        return { output: ctx.output, error: null };
    }
    throw new Error("No prompt input element, terminal is closed.");
};
// Reductions
const reduceNextHistory = reduce((ctx, evt) => {
    const history = ctx.history;
    const historyIndex = ctx.historyIndex + 1;
    if (historyIndex === 1 && ctx.input !== "") {
        history.push(ctx.input);
    }
    const input = history[historyIndex] ?? "";
    ctx.terminalInput.value = input;
    return { ...ctx, input, historyIndex, history };
});
const reducePrevHistory = reduce((ctx, evt) => {
    const history = ctx.history;
    const historyIndex = ctx.historyIndex - 1;
    if (historyIndex < 0) {
        ctx.terminalInput.value = "";
        return { ...ctx, input: "", historyIndex: 0 };
    }
    const input = history[historyIndex] ?? "";
    if (historyIndex === 1)
        history.pop();
    ctx.terminalInput.value = input;
    return { ...ctx, input, historyIndex, history };
});
// Terminal machine
const terminalMachine = createMachine("closed", {
    closed: state(transition("activate", "activating")),
    activating: doThenElse(terminalActivation, "focus", "closed"),
    deactivating: doThenElse(terminalDeactivation, "closed", "closed"),
    focus: doThenElse(inputFocusing, "focused", "error"),
    clear: doThenElse(inputClearing, "focus", "error"),
    focused: state(transition("typing", "focused", reduceWithKeys("input", "message")), transition("next-history", "focused", guardKeyZero("historyIndex"), reduceNextHistory), transition("prev-history", "focused", reducePrevHistory), transition("eval", "eval", reduceWithKeys("input", "message")), transition("focus", "focus"), transition("close-console", "deactivating"), transition("error", "error", reduceWithKeys("error", "error"))),
    "clear-terminal": state(immediate("clear", reduceSetKeyValue("output", []))),
    eval: doThenElse(terminalEvaluation, "evaluated", "error"),
    evaluated: createSwitchState([
        ["deactivating", "close-console"],
        ["clear-terminal"],
        ["start-dc"],
        ["stop-dc"],
        ["error"],
        ["clear"],
    ]),
    error: doThenElse(errorTerminal, "focus", "error"),
}, () => store);
// Should make better use of this
// Currently only used to update the store with the current context
const terminalStateChange = ({ context, machine, send }) => {
    context.debug && console.log("terminal machine change", machine, context);
    Object.assign(store, context);
};
const terminalMachineService = interpret(terminalMachine, terminalStateChange);
// Handle keyup events on the terminal prompt input
const handlePromptKeys = (e) => {
    const { target, key } = e;
    const message = target.value;
    // TODO: switch case statement ?
    if (key === "Enter")
        terminalMachineService.send({ type: "eval", message });
    else if (key === "Escape")
        terminalMachineService.send("close-console");
    else if (key === "ArrowUp")
        terminalMachineService.send({ type: "next-history" });
    else if (key === "ArrowDown")
        terminalMachineService.send({ type: "prev-history" });
    else
        terminalMachineService.send({ type: "typing", message });
};
const consoleTemplate = createCommandConsoleTemplate(TERMINAL_ID, PROMPT_ID, TERMINAL_OUTPUT_ID, store, handlePromptKeys);
// Document key commands
const BODY_KEY_COMMANDS = {
    Escape: "close-console",
    "`": "activate",
    Backspace: "go-back",
};
// Bind document body key events to the machine service
document.body.addEventListener("keyup", (e) => {
    const current = terminalMachineService.machine.current;
    let command = BODY_KEY_COMMANDS[e.key];
    if (!command)
        return;
    if (current === "closed") {
        if (command === "go-back")
            return window.history.go(-1);
        if (command !== "activate")
            return;
    }
    else {
        if (command === "activate")
            command = "focus";
        if (command === "go-back")
            return;
    }
    console.log(`Send "${command}" event`);
    terminalMachineService.send(command);
});
document.querySelectorAll("sup.note").forEach(el => {
    el.addEventListener("click", () => { });
});
//# sourceMappingURL=index.js.map