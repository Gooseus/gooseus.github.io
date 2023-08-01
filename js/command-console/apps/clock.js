import { reactive, html } from "../../../js/arrow.js";
const pad = (n, p = "0") => n.toString().padStart(2, p);
const makeTimeFormat = (method) => date => pad(date[method]);
const timeFormats = [
    makeTimeFormat("getHours"),
    makeTimeFormat("getMinutes"),
    makeTimeFormat("getSeconds"),
];
const getTimeDisplays = time => timeFormats.map(format => format(time));
const update = store => () => {
    const [hour, min, sec] = getTimeDisplays(new Date());
    store.display = `${hour}:${min}:${sec}`;
};
export const Clock = (mode = "default", opts) => {
    const clockStore = reactive({ display: "00:00:00", mode, ...opts });
    const attachClock = html `<div id="clock">
    <div id="clock-display">${() => clockStore.display}</div>
  </div>`;
    const startClock = (element, mode_override) => {
        if (mode_override)
            clockStore.mode = mode_override;
        console.log("starting clock mode:", mode);
        const clockInterval = setInterval(update(clockStore), 1000);
        attachClock(element);
        return clockInterval;
    };
    return [startClock, clockStore];
};
//# sourceMappingURL=clock.js.map