import { html } from "../../js/arrow.js";
import "../../js/robot3/debug.js";
import { Timer } from "./apps/timer.js";
import { Clock } from "./apps/clock.js";
const runningApps = [];
const APPS = {
    clock: (mode = "default") => {
        const [startClock, clockData] = Clock(mode);
        const clockInterval = startClock(document.getElementById("apps"));
        runningApps.push({
            name: "clock",
            interval: clockInterval,
            data: clockData,
        });
        return `Started clock in mode: ${mode}`;
    },
    timer: (mode = "default") => {
        const [startTimer, timerData] = Timer(mode);
        const timerInterval = startTimer(document.getElementById("apps"));
        runningApps.push({
            name: "timer",
            interval: timerInterval,
            data: timerData,
        });
        return `Started timer in mode: ${mode}`;
    },
    roll: (dice = "1d20") => {
        const [count, sides] = dice.split("d").map((n) => parseInt(n));
        const rolls = [];
        for (let i = 0; i < count; i++) {
            rolls.push(Math.ceil(Math.random() * sides));
        }
        return `Rolling ${dice}: ${rolls.join(", ")}`;
    },
};
// Interpreter constants
const LINKS = {
    projects: "/projects/",
    reviews: "/reviews/",
    writing: "/writing/",
    about: "/about/",
    resume: "/resume/",
};
const HELP_MESSAGE = `<pre>
<b>help</b> - show this help
<b>clear</b> - clear the terminal
<b>close</b> | <b>&lt;esc&gt;</b> - close the terminal
<b>start</b> [name] - start an app
  Available apps:
    <b>clock [mode='default']</b> - show the current time
    <b>timer [mode='default']</b> - show a stopwatch timer
    <b>roll [mode='1d20']</b> - roll the di(c)e
<b>stop</b> [name] - stop an app
<b>goto</b> [n] - navigate to any valid URL or a local page
<b>set</b> [attr] [value] - set an attribute value on the document body
<b>get</b> [attr] - get an attribute value from the document body
</pre>`;
const msgNext = (next, message, log) => (log && console.log(log), { message, next, timestamp: new Date().toLocaleString() });
// Interpreter commands
const COMMANDS = {
    help: () => HELP_MESSAGE,
    clear: () => msgNext("clear-terminal", `Console output cleared`, "Clearing console output"),
    close: () => msgNext("close-console", "Closed console", "Closing command console"),
    start: (app, ...args) => {
        console.log('Starting "app":', app, args);
        if (app in APPS)
            return APPS[app](...args);
        else
            return msgNext("error", `Cannot start unknown app: ${app}`);
    },
    stop: (app) => {
        console.log('Stopping "app":', app);
        const appIndex = runningApps.findIndex((a) => a.name === app);
        if (appIndex > -1) {
            clearInterval(runningApps[appIndex].interval);
            runningApps.splice(appIndex, 1);
            return `Stopped app: ${app}`;
        }
        else
            return msgNext("error", `Cannot stop unknown app: ${app}`);
    },
    goto: (link) => {
        if (LINKS[link]) {
            location.href = LINKS[link];
            return `Going to ${location.href}`;
        }
        if (link.startsWith("http")) {
            link = link.replace(/http(s)/, "https");
            try {
                const url = new URL(link);
                if (confirm(`Are you sure you want to go to ${url.hostname}?`)) {
                    location.href = url.href;
                    return `Going to ${url.hostname}`;
                }
                return `Cancelled going to ${url.hostname}`;
            }
            catch (e) {
                return msgNext("error", `Link "${link}" does not seem to be a valid URL`);
            }
        }
    },
};
// Interpreters
export const commandConsoleInterpreter = (message, ...args) => {
    if (message in COMMANDS) {
        try {
            return COMMANDS[message](...args);
        }
        catch (error) {
            throw error;
        }
    }
    else {
        throw new Error(`Cannot run unknown command: ${message}`);
    }
};
// Command Console Template
export const createCommandConsoleTemplate = (consoleId, inputId, outputId, store, handleKeyup) => {
    return html `<div id="${consoleId}" class="${() => store.mode}">
    <div>Terminal: ${() => store.test}</div>
    <ul id="${outputId}">
      ${() => store.output.map((line) => html `<li class="${line.type}">
            <span class="timestamp">${line.timestamp}</span>
            ${line.display}
          </li>`)}
    </ul>
    <div id="prompt">
      <input autocomplete="off" id="${inputId}" type="text" @keyup="${handleKeyup}" />
    </div>
  </div>`;
};
//# sourceMappingURL=index.js.map