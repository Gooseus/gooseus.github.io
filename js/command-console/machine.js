import { commandConsoleInterpreter, } from "./index.js";
// Terminal constants
const TERMINAL_ID = "terminal";
const PROMPT_ID = "terminal-input";
const TERMINAL_OUTPUT_ID = "terminal-output";
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
//# sourceMappingURL=machine.js.map