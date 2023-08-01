import { invoke, reduce, state, transition, immediate, guard, } from "../js/robot3/machine.js";
export const reduceWithKeys = (ck, ek) => reduce((ctx, evt) => {
    return {
        ...ctx,
        ...(evt.data ? evt.data : { [ck]: evt[ek] }),
        ...(evt.error ? { error: evt.error } : { error: null }),
    };
});
export const reduceSetKeyValue = (key, value) => reduce((ctx) => ({ ...ctx, [key]: value }));
// Standard Transitions
const onRejectStoreErrorThenGo = dst => transition("error", dst, reduceWithKeys("error", "error"));
const onResolveMergeDataThenGo = dst => transition("done", dst, reduceWithKeys("data", "data"));
export const doThenElse = (fn, dst, err) => invoke(fn, onResolveMergeDataThenGo(dst), onRejectStoreErrorThenGo(err));
// Guards
const guardNext = next => guard((ctx) => ctx.next === next);
export const guardKeyZero = key => guard((ctx) => ctx[key] === 0);
// Switch states have an array of immediate transitions with guards on the `next` context property
export const createSwitchState = (cases) => {
    const final = cases.pop();
    const transitions = cases.map(([dst, next]) => {
        next = next ?? dst;
        return immediate(dst, guardNext(next));
    });
    const switchState = state(...[...transitions, immediate(final)]);
    return switchState;
};
//# sourceMappingURL=robot-utils.js.map