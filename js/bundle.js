(function () {
    'use strict';

    /**
     * A queue of expressions to run as soon as an async slot opens up.
     */
    const queueStack = new Set();
    /**
     * A stack of functions to run on the next tick.
     */
    const nextTicks = new Set();
    function isTpl(template) {
        return typeof template === 'function' && !!template.isT;
    }
    function isR(obj) {
        return (typeof obj === 'object' &&
            obj !== null &&
            '$on' in obj &&
            typeof obj.$on === 'function');
    }
    function isReactiveFunction(fn) {
        return '$on' in fn;
    }
    /**
     * Queue an item to execute after all synchronous functions have been run. This
     * is used for `w()` to ensure multiple dependency mutations tracked on the
     * same expression do not result in multiple calls.
     * @param  {CallableFunction} fn
     * @returns ObserverCallback
     */
    function queue(fn) {
        return (newValue, oldValue) => {
            function executeQueue() {
                // copy the current queues and clear it to allow new items to be added
                // during the execution of the current queue.
                const queue = Array.from(queueStack);
                queueStack.clear();
                const ticks = Array.from(nextTicks);
                nextTicks.clear();
                queue.forEach((fn) => fn(newValue, oldValue));
                ticks.forEach((fn) => fn());
                if (queueStack.size) {
                    // we received new items while executing the queue, so we need to
                    // execute the queue again.
                    setTimeout(executeQueue);
                }
            }
            if (!queueStack.size) {
                setTimeout(executeQueue);
            }
            queueStack.add(fn);
        };
    }

    /**
     * A "global" dependency tracker object.
     */
    const dependencyCollector = new Map();
    /**
     * Given a data object, often an object literal, return a proxy of that object
     * with mutation observers for each property.
     *
     * @param  {DataSource} data
     * @returns ReactiveProxy
     */
    function r(data, state = {}) {
        // If this is already reactive or a non object, just return it.
        if (isR(data) || typeof data !== 'object')
            return data;
        // This is the observer registry itself, with properties as keys and callbacks as watchers.
        const observers = state.o || new Map();
        // This is a reverse map of observers with callbacks as keys and properties that callback is watching as values.
        const observerProperties = state.op || new Map();
        // If the data is an array, we should know...but only once.
        const isArray = Array.isArray(data);
        const children = [];
        const proxySource = isArray ? [] : Object.create(data, {});
        for (const property in data) {
            const entry = data[property];
            if (typeof entry === 'object' && entry !== null) {
                proxySource[property] = !isR(entry) ? r(entry) : entry;
                children.push(property);
            }
            else {
                proxySource[property] = entry;
            }
        }
        // The add/remove dependency function(s)
        const dep = (a) => (p, c) => {
            let obs = observers.get(p);
            let props = observerProperties.get(c);
            if (!obs) {
                obs = new Set();
                observers.set(p, obs);
            }
            if (!props) {
                props = new Set();
                observerProperties.set(c, props);
            }
            obs[a](c);
            props[a](p);
        };
        // Add a property listener
        const $on = dep('add');
        // Remove a property listener
        const $off = dep('delete');
        // Emit a property mutation event by calling all sub-dependencies.
        const _em = (property, newValue, oldValue) => {
            observers.has(property) &&
                observers.get(property).forEach((c) => c(newValue, oldValue));
        };
        /**
         * Return the reactive proxy state data.
         */
        const _st = () => {
            return {
                o: observers,
                op: observerProperties,
                r: proxySource,
                p: proxy._p,
            };
        };
        // These are the internal properties of all `r()` objects.
        const depProps = {
            $on,
            $off,
            _em,
            _st,
            _p: undefined,
        };
        // Create the actual proxy object itself.
        const proxy = new Proxy(proxySource, {
            has(target, key) {
                return key in depProps || key in target;
            },
            get(...args) {
                const [, p] = args;
                // For properties of the DependencyProps type, return their values from
                // the depProps instead of the target.
                if (Reflect.has(depProps, p))
                    return Reflect.get(depProps, p);
                const value = Reflect.get(...args);
                // For any existing dependency collectors that are active, add this
                // property to their observed properties.
                addDep(proxy, p);
                // We have special handling of array operations to prevent O(n^2) issues.
                if (isArray && p in Array.prototype) {
                    return arrayOperation(p, proxySource, proxy, value);
                }
                return value;
            },
            set(...args) {
                const [target, property, value] = args;
                const old = Reflect.get(target, property);
                if (Reflect.has(depProps, property)) {
                    // We are setting a reserved property like _p
                    return Reflect.set(depProps, property, value);
                }
                if (value && isR(old)) {
                    const o = old;
                    // We're assigning an object (array or pojo probably), so we want to be
                    // reactive, but if we already have a reactive object in this
                    // property, then we need to replace it and transfer the state of deps.
                    const oldState = o._st();
                    const newR = isR(value) ? reactiveMerge(value, o) : r(value, oldState);
                    Reflect.set(target, property, 
                    // Create a new reactive object
                    newR);
                    _em(property, newR);
                    oldState.o.forEach((_c, property) => {
                        const oldValue = Reflect.get(old, property);
                        const newValue = Reflect.get(newR, property);
                        if (oldValue !== newValue) {
                            o._em(property, newValue, oldValue);
                        }
                    });
                    return true;
                }
                const didSet = Reflect.set(...args);
                if (didSet) {
                    if (old !== value) {
                        // Notify any discrete property observers of the change.
                        _em(property, value, old);
                    }
                    if (proxy._p) {
                        // Notify parent observers of a change.
                        proxy._p[1]._em(...proxy._p);
                    }
                }
                return didSet;
            },
        });
        if (state.p)
            proxy._p = state.p;
        // Before we return the proxy object, quickly map through the children
        // and set the parents (this is only run on the initial setup).
        children.map((c) => {
            proxy[c]._p = [c, proxy];
        });
        return proxy;
    }
    /**
     * Add a property to the tracked reactive properties.
     * @param  {ReactiveProxy} proxy
     * @param  {DataSourceKey} property
     */
    function addDep(proxy, property) {
        dependencyCollector.forEach((tracker) => {
            let properties = tracker.get(proxy);
            if (!properties) {
                properties = new Set();
                tracker.set(proxy, properties);
            }
            properties.add(property);
        });
    }
    function arrayOperation(op, arr, proxy, native) {
        const synthetic = (...args) => {
            // The `as DataSource` here should really be the ArrayPrototype, but we're
            // just tricking the compiler since we've already checked it.
            const retVal = Array.prototype[op].call(arr, ...args);
            // @todo determine how to handle notifying elements and parents of elements.
            arr.forEach((item, i) => proxy._em(String(i), item));
            // Notify the the parent of changes.
            if (proxy._p) {
                const [property, parent] = proxy._p;
                parent._em(property, proxy);
            }
            return retVal;
        };
        switch (op) {
            case 'shift':
            case 'pop':
            case 'sort':
            case 'reverse':
            case 'copyWithin':
                return synthetic;
            case 'unshift':
            case 'push':
            case 'fill':
                return (...args) => synthetic(...args.map((arg) => r(arg)));
            case 'splice':
                return (start, remove, ...inserts) => synthetic(start, remove, ...inserts.map((arg) => r(arg)));
            default:
                return native;
        }
    }
    /**
     * Given two reactive proxies, merge the important state attributes from the
     * source into the target.
     * @param  {ReactiveProxy} reactiveTarget
     * @param  {ReactiveProxy} reactiveSource
     * @returns ReactiveProxy
     */
    function reactiveMerge(reactiveTarget, reactiveSource) {
        const state = reactiveSource._st();
        if (state.o) {
            state.o.forEach((callbacks, property) => {
                callbacks.forEach((c) => {
                    reactiveTarget.$on(property, c);
                });
            });
        }
        if (state.p) {
            reactiveTarget._p = state.p;
        }
        return reactiveTarget;
    }
    /**
     * Watch a function and track any reactive dependencies on it, re-calling it if
     * those dependencies are changed.
     * @param  {CallableFunction} fn
     * @param  {CallableFunction} after?
     * @returns unknown
     */
    function w(fn, after) {
        const trackingId = Symbol();
        if (!dependencyCollector.has(trackingId)) {
            dependencyCollector.set(trackingId, new Map());
        }
        let currentDeps = new Map();
        const queuedCallFn = queue(callFn);
        function callFn() {
            dependencyCollector.set(trackingId, new Map());
            const value = fn();
            const newDeps = dependencyCollector.get(trackingId);
            dependencyCollector.delete(trackingId);
            // Disable existing properties
            currentDeps.forEach((propertiesToUnobserve, proxy) => {
                const newProperties = newDeps.get(proxy);
                if (newProperties) {
                    newProperties.forEach((prop) => propertiesToUnobserve.delete(prop));
                }
                propertiesToUnobserve.forEach((prop) => proxy.$off(prop, queuedCallFn));
            });
            // Start observing new properties.
            newDeps.forEach((properties, proxy) => {
                properties.forEach((prop) => proxy.$on(prop, queuedCallFn));
            });
            currentDeps = newDeps;
            return after ? after(value) : value;
        }
        // If this is a reactive function, then when the expression is updated, re-run
        if (isReactiveFunction(fn))
            fn.$on(callFn);
        return callFn();
    }

    /**
     * Event listeners that were bound by arrow and should be cleaned up should the
     * given node be garbage collected.
     */
    const listeners = new WeakMap();
    /**
     * A list of HTML templates to a HTMLTemplate element that contains instances
     * of each. This acts as a cache.
     */
    const templateMemo = {};
    /**
     * The delimiter that describes where expressions are located.
     */
    const delimiter = '➳❍';
    const bookend = '❍⇚';
    const delimiterComment = `<!--${delimiter}-->`;
    const bookendComment = `<!--${bookend}-->`;
    /**
     * The template tagging function, used like: html`<div></div>`(mountEl)
     * @param  {TemplateStringsArray} strings
     * @param  {any[]} ...expressions
     * @returns ArrowTemplate
     */
    function t(strings, ...expSlots) {
        const expressions = [];
        let str = '';
        const addExpressions = (expression, html) => {
            if (typeof expression === 'function') {
                // eslint-disable-next-line @typescript-eslint/no-empty-function
                let observer = () => { };
                expressions.push(Object.assign((...args) => expression(...args), {
                    e: expression,
                    $on: (obs) => {
                        observer = obs;
                    },
                    _up: (exp) => {
                        expression = exp;
                        observer();
                    },
                }));
                return html + delimiterComment;
            }
            if (Array.isArray(expression)) {
                return expression.reduce((html, exp) => addExpressions(exp, html), html);
            }
            return html + expression;
        };
        const toString = () => {
            if (!str) {
                if (!expSlots.length && strings.length === 1 && strings[0] === '') {
                    str = '<!---->';
                }
                else {
                    str = strings.reduce(function interlaceTemplate(html, strVal, i) {
                        html += strVal;
                        return expSlots[i] !== undefined
                            ? addExpressions(expSlots[i], html)
                            : html;
                    }, '');
                }
            }
            return str;
        };
        const template = (el) => {
            const dom = createNodes(toString());
            const frag = fragment(dom, { i: 0, e: expressions });
            return el ? frag(el) : frag();
        };
        // If the template contains no expressions, it is 100% static so it's key
        // its own content
        template.isT = true;
        template._k = 0;
        template._h = () => [toString(), expressions, template._k];
        template.key = (key) => {
            template._k = key;
            return template;
        };
        return template;
    }
    /**
     * @param  {NodeList} dom
     * @param  {ReactiveExpressions} tokens
     * @param  {ReactiveProxy} data?
     */
    function fragment(dom, expressions) {
        const frag = document.createDocumentFragment();
        let node;
        while ((node = dom.item(0))) {
            // Delimiters in the body are found inside comments.
            if (node.nodeType === 8 && node.nodeValue === delimiter) {
                // We are dealing with a reactive node.
                frag.append(comment(node, expressions));
                continue;
            }
            // Bind attributes, add events, and push onto the fragment.
            if (node instanceof Element)
                attrs(node, expressions);
            if (node.hasChildNodes()) {
                fragment(node.childNodes, expressions)(node);
            }
            frag.append(node);
            // Select lists "default" selections get out of wack when being moved around
            // inside fragments, this resets them.
            if (node instanceof HTMLOptionElement)
                node.selected = node.defaultSelected;
        }
        return ((parent) => {
            if (parent) {
                parent.appendChild(frag);
                return parent;
            }
            return frag;
        });
    }
    /**
     * Given a node, parse for meaningful expressions.
     * @param  {Element} node
     * @returns void
     */
    function attrs(node, expressions) {
        var _a;
        const toRemove = [];
        let i = 0;
        let attr;
        while ((attr = node.attributes[i++])) {
            if (expressions.i >= expressions.e.length)
                return;
            if (attr.value !== delimiterComment)
                continue;
            let attrName = attr.name;
            const expression = expressions.e[expressions.i++];
            if (attrName.charAt(0) === '@') {
                const event = attrName.substring(1);
                node.addEventListener(event, expression);
                if (!listeners.has(node))
                    listeners.set(node, new Map());
                (_a = listeners.get(node)) === null || _a === void 0 ? void 0 : _a.set(event, expression);
                toRemove.push(attrName);
            }
            else {
                // Logic to determine if this is an IDL attribute or a content attribute
                const isIDL = (attrName === 'value' && 'value' in node) ||
                    attrName === 'checked' ||
                    (attrName.startsWith('.') && (attrName = attrName.substring(1)));
                w(expression, (value) => {
                    if (isIDL) {
                        // Handle all IDL attributes, TS won’t like this since it is not
                        // fully aware of the type we are operating on, but JavaScript is
                        // perfectly fine with it, so we need to ignore TS here.
                        // @ts-ignore:next-line
                        node[attrName] = value;
                        // Explicitly set the "value" to false remove the attribute. However
                        // we need to be sure this is not a "Reflected" attribute, so we check
                        // the current value of the attribute to make sure it is not the same
                        // as the value we just set. If it is the same, it must be reflected.
                        // so removing the attribute would remove the idl we just set.
                        if (node.getAttribute(attrName) != value)
                            value = false;
                    }
                    // Set a standard content attribute.
                    value !== false
                        ? node.setAttribute(attrName, value)
                        : (node.removeAttribute(attrName), i--);
                });
            }
        }
        toRemove.forEach((attrName) => node.removeAttribute(attrName));
    }
    /**
     * Removes DOM nodes from the dom and cleans up any attached listeners.
     * @param node - A DOM element to remove
     */
    function removeNodes(node) {
        node.forEach(removeNode);
    }
    /**
     * Removes the node from the dom and cleans up any attached listeners.
     * @param node - A DOM element to remove
     */
    function removeNode(node) {
        var _a;
        node.remove();
        (_a = listeners
            .get(node)) === null || _a === void 0 ? void 0 : _a.forEach((listener, event) => node.removeEventListener(event, listener));
    }
    /**
     * Given a textNode, parse the node for expressions and return a fragment.
     * @param  {Node} node
     * @param  {ReactiveProxy} data
     * @param  {ReactiveExpressions} tokens
     * @returns DocumentFragment
     */
    function comment(node, expressions) {
        const frag = document.createDocumentFragment();
        node.remove();
        // At this point, we know we're dealing with some kind of reactive token fn
        const expression = expressions.e[expressions.i++];
        if (expression && isTpl(expression.e)) {
            // If the expression is an html`` (ArrowTemplate), then call it with data
            // and then call the ArrowTemplate with no parent, so we get the nodes.
            frag.appendChild(createPartial().add(expression.e)());
        }
        else {
            // This is where the *actual* reactivity takes place:
            let partialMemo;
            frag.appendChild((partialMemo = w(expression, (value) => setNode(value, partialMemo)))());
        }
        return frag;
    }
    /**
     * Set the value of a given node.
     * @param  {Node} n
     * @param  {any} value
     * @param  {ReactiveProxy} data
     * @returns Node
     */
    function setNode(value, p) {
        const isUpdate = typeof p === 'function';
        const partial = isUpdate ? p : createPartial();
        Array.isArray(value)
            ? value.forEach((item) => partial.add(item))
            : partial.add(value);
        if (isUpdate)
            partial._up();
        return partial;
    }
    /**
     * Given an HTML string, produce actual DOM elements.
     * @param html - a string of html
     * @returns
     */
    function createNodes(html) {
        var _a;
        const tpl = (_a = templateMemo[html]) !== null && _a !== void 0 ? _a : (() => {
            const tpl = document.createElement('template');
            tpl.innerHTML = html;
            return (templateMemo[html] = tpl);
        })();
        const dom = tpl.content.cloneNode(true);
        dom.normalize(); // textNodes are automatically split somewhere around 65kb, this joins them back together.
        return dom.childNodes;
    }
    /**
     * Template partials are stateful functions that perform a fragment render when
     * called, but also have function properties like ._up() which attempts to only
     * perform a patch of the previously rendered nodes.
     * @returns TemplatePartial
     */
    function createPartial(group = Symbol()) {
        let html = '';
        let expressions = { i: 0, e: [] };
        let chunks = [];
        let previousChunks = [];
        const keyedChunks = new Map();
        const toRemove = [];
        /**
         * This is the actual document partial function.
         */
        const partial = () => {
            let dom;
            if (!chunks.length)
                addPlaceholderChunk();
            if (chunks.length === 1 && !isTpl(chunks[0].tpl)) {
                // In this case we have only a textNode to render, so we can just return
                // the text node with the proper value applied.
                const chunk = chunks[0];
                chunk.dom.length
                    ? (chunk.dom[0].nodeValue = chunk.tpl)
                    : chunk.dom.push(document.createTextNode(chunk.tpl));
                dom = chunk.dom[0];
            }
            else {
                dom = assignDomChunks(fragment(createNodes(html), expressions)());
            }
            reset();
            return dom;
        };
        partial.ch = () => previousChunks;
        partial.l = 0;
        partial.add = (tpl) => {
            if (!tpl && tpl !== 0)
                return partial;
            // If the tpl is a string or a number it means the result should be a
            // textNode — in that case we do *not* want to generate any DOM nodes for it
            // so here we want to ensure that `html` is just ''.
            let localExpressions = [];
            let key;
            let template = '';
            if (isTpl(tpl)) {
                [template, localExpressions, key] = tpl._h();
            }
            html += template;
            html += bookendComment;
            const keyedChunk = key && keyedChunks.get(key);
            const chunk = keyedChunk || {
                html: template,
                exp: localExpressions,
                dom: [],
                tpl,
                key,
            };
            chunks.push(chunk);
            if (key) {
                // Since this is a keyed chunk, we need to either add it to the
                // keyedChunks map, or we need to update the expressions in that chunk.
                keyedChunk
                    ? keyedChunk.exp.forEach((exp, i) => exp._up(localExpressions[i].e))
                    : keyedChunks.set(key, chunk);
            }
            expressions.e.push(...localExpressions);
            partial.l++;
            return partial;
        };
        partial._up = () => {
            const subPartial = createPartial(group);
            let startChunking = 0;
            let lastNode = previousChunks[0].dom[0];
            // If this is an empty update, we need to "placehold" its spot in the dom
            // with an empty placeholder chunk.
            if (!chunks.length)
                addPlaceholderChunk(document.createComment(''));
            const closeSubPartial = () => {
                if (!subPartial.l)
                    return;
                const frag = subPartial();
                const last = frag.lastChild;
                lastNode[startChunking ? 'after' : 'before'](frag);
                transferChunks(subPartial, chunks, startChunking);
                lastNode = last;
            };
            chunks.forEach((chunk, index) => {
                // There are a few things that can happen in here:
                // 1. We match a key and output previously rendered nodes.
                // 2. We use a previous rendered dom, and swap the expression.
                // 3. The actual HTML chunk is changed/new so we need to remove the nodes.
                // 4. We render totally new nodes using a partial.
                const prev = previousChunks[index];
                if (chunk.key && chunk.dom.length) {
                    closeSubPartial();
                    // This is a keyed dom chunk that has already been rendered.
                    if (!prev || prev.dom !== chunk.dom) {
                        lastNode[index ? 'after' : 'before'](...chunk.dom);
                    }
                    lastNode = chunk.dom[chunk.dom.length - 1];
                    // Note: we don't need to update keyed chunks expressions here because
                    // it is done in partial.add as soon as a keyed chunk is added to the
                    // partial.
                }
                else if (prev && chunk.html === prev.html && !prev.key) {
                    // We can reuse the DOM node, and need to swap the expressions. First
                    // close out any partial chunks. Then "upgrade" the expressions.
                    closeSubPartial();
                    prev.exp.forEach((expression, i) => expression._up(chunk.exp[i].e));
                    // We always want to reference the root expressions as long as the
                    // chunks remain equivalent, so here we explicitly point the new chunk's
                    // expression set to the original chunk expression set — which was just
                    // updated with the new expression's "values".
                    chunk.exp = prev.exp;
                    chunk.dom = prev.dom;
                    lastNode = chunk.dom[chunk.dom.length - 1];
                    if (isTextNodeChunk(chunk) && lastNode instanceof Text) {
                        lastNode.nodeValue = chunk.tpl;
                    }
                }
                else {
                    if (prev && chunk.html !== prev.html && !prev.key) {
                        // The previous chunk in this position has changed its underlying html
                        // this happens when someone is using non-reactive values in the
                        // template. We need to remove the previous nodes.
                        toRemove.push(...prev.dom);
                    }
                    // Ok, now we're building some new DOM up y'all, let the chunking begin!
                    if (!subPartial.l)
                        startChunking = index;
                    subPartial.add(chunk.tpl);
                }
            });
            closeSubPartial();
            let node = lastNode === null || lastNode === void 0 ? void 0 : lastNode.nextSibling;
            while (node && group in node) {
                toRemove.push(node);
                const next = node.nextSibling;
                node = next;
            }
            removeNodes(toRemove);
            reset();
        };
        // What follows are internal "methods" for each partial.
        const reset = () => {
            toRemove.length = 0;
            html = '';
            partial.l = 0;
            expressions = { i: 0, e: [] };
            previousChunks = [...chunks];
            chunks = [];
        };
        const addPlaceholderChunk = (node) => {
            html = '<!---->';
            chunks.push({
                html,
                exp: [],
                dom: node ? [node] : [],
                tpl: t `${html}`,
                key: 0,
            });
        };
        /**
         * Walks through the document fragment and assigns the nodes to the correct
         * DOM chunk. Chunks of DOM are divided by the bookend comment.
         * @param frag - A document fragment that has been created from a partial
         * @returns
         */
        const assignDomChunks = (frag) => {
            let chunkIndex = 0;
            const toRemove = [];
            frag.childNodes.forEach((node) => {
                if (node.nodeType === 8 && node.data === bookend) {
                    chunkIndex++;
                    // Remove the comment
                    toRemove.push(node);
                    return;
                }
                Object.defineProperty(node, group, { value: group });
                chunks[chunkIndex].dom.push(node);
            });
            toRemove.forEach((node) => node.remove());
            return frag;
        };
        const transferChunks = (partialA, chunksB, chunkIndex) => {
            partialA.ch().forEach((chunk, index) => {
                chunksB[chunkIndex + index].dom = chunk.dom;
            });
        };
        return partial;
    }
    /**
     * Checks if a given chunk is a textNode chunk.
     * @param chunk - A partial chunk
     * @returns
     */
    function isTextNodeChunk(chunk) {
        return chunk.dom.length === 1 && !isTpl(chunk.tpl);
    }

    /**
     * html is an alias for t
     */
    const html = t;
    /**
     * reactive is an alias for r
     */
    const reactive = r;

    // Object.defineProperty(exports, '__esModule', { value: true });

    function valueEnumerable(value) {
      return { enumerable: true, value };
    }

    function valueEnumerableWritable(value) {
      return { enumerable: true, writable: true, value };
    }

    let d = {};
    let truthy = () => true;
    let empty = () => ({});
    let identity = a => a;
    let callBoth = (par, fn, self, args) => par.apply(self, args) && fn.apply(self, args);
    let callForward = (par, fn, self, [a, b]) => fn.call(self, par.call(self, a, b), b);
    let create = (a, b) => Object.freeze(Object.create(a, b));

    function stack(fns, def, caller) {
      return fns.reduce((par, fn) => {
        return function(...args) {
          return caller(par, fn, this, args);
        };
      }, def);
    }

    function fnType(fn) {
      return create(this, { fn: valueEnumerable(fn) });
    }

    let reduceType = {};
    let reduce = fnType.bind(reduceType);

    let guardType = {};
    let guard = fnType.bind(guardType);

    function filter(Type, arr) {
      return arr.filter(value => Type.isPrototypeOf(value));
    }

    function makeTransition(from, to, ...args) {
      let guards = stack(filter(guardType, args).map(t => t.fn), truthy, callBoth);
      let reducers = stack(filter(reduceType, args).map(t => t.fn), identity, callForward);
      return create(this, {
        from: valueEnumerable(from),
        to: valueEnumerable(to),
        guards: valueEnumerable(guards),
        reducers: valueEnumerable(reducers)
      });
    }

    let transitionType = {};
    let immediateType = {};
    let transition = makeTransition.bind(transitionType);
    let immediate = makeTransition.bind(immediateType, null);

    function enterImmediate(machine, service, event) {
      return transitionTo(service, machine, event, this.immediates) || machine;
    }

    function transitionsToMap(transitions) {
      let m = new Map();
      for(let t of transitions) {
        if(!m.has(t.from)) m.set(t.from, []);
        m.get(t.from).push(t);
      }
      return m;
    }

    let stateType = { enter: identity };
    function state(...args) {
      let transitions = filter(transitionType, args);
      let immediates = filter(immediateType, args);
      let desc = {
        final: valueEnumerable(args.length === 0),
        transitions: valueEnumerable(transitionsToMap(transitions))
      };
      if(immediates.length) {
        desc.immediates = valueEnumerable(immediates);
        desc.enter = valueEnumerable(enterImmediate);
      }
      return create(stateType, desc);
    }

    let invokeFnType = {
      enter(machine2, service, event) {
        let rn = this.fn.call(service, service.context, event);
        if(machine.isPrototypeOf(rn))
          return create(invokeMachineType, {
            machine: valueEnumerable(rn),
            transitions: valueEnumerable(this.transitions)
          }).enter(machine2, service, event)
        rn.then(data => service.send({ type: 'done', data }))
          .catch(error => service.send({ type: 'error', error }));
        return machine2;
      }
    };
    let invokeMachineType = {
      enter(machine, service, event) {
        service.child = interpret(this.machine, s => {
          service.onChange(s);
          if(service.child == s && s.machine.state.value.final) {
            delete service.child;
            service.send({ type: 'done', data: s.context });
          }
        }, service.context, event);
        if(service.child.machine.state.value.final) {
          let data = service.child.context;
          delete service.child;
          return transitionTo(service, machine, { type: 'done', data }, this.transitions.get('done'));
        }
        return machine;
      }
    };
    function invoke(fn, ...transitions) {
      let t = valueEnumerable(transitionsToMap(transitions));
      return machine.isPrototypeOf(fn) ?
        create(invokeMachineType, {
          machine: valueEnumerable(fn),
          transitions: t
        }) :
        create(invokeFnType, {
          fn: valueEnumerable(fn),
          transitions: t
        });
    }

    let machine = {
      get state() {
        return {
          name: this.current,
          value: this.states[this.current]
        };
      }
    };

    function createMachine(current, states, contextFn = empty) {
      if(typeof current !== 'string') {
        contextFn = states || empty;
        states = current;
        current = Object.keys(states)[0];
      }
      if(d._create) d._create(current, states);
      return create(machine, {
        context: valueEnumerable(contextFn),
        current: valueEnumerable(current),
        states: valueEnumerable(states)
      });
    }

    function transitionTo(service, machine, fromEvent, candidates) {
      let { context } = service;
      for(let { to, guards, reducers } of candidates) {  
        if(guards(context, fromEvent)) {
          service.context = reducers.call(service, context, fromEvent);

          let original = machine.original || machine;
          let newMachine = create(original, {
            current: valueEnumerable(to),
            original: { value: original }
          });

          if (d._onEnter) d._onEnter(machine, to, service.context, context, fromEvent);
          let state = newMachine.state.value;
          return state.enter(newMachine, service, fromEvent);
        }
      }
    }

    function send(service, event) {
      let eventName = event.type || event;
      let { machine } = service;
      let { value: state, name: currentStateName } = machine.state;
      
      if(state.transitions.has(eventName)) {
        return transitionTo(service, machine, event, state.transitions.get(eventName)) || machine;
      } else {
        if(d._send) d._send(eventName, currentStateName);
      }
      return machine;
    }

    let service = {
      send(event) {
        this.machine = send(this, event);
        
        // TODO detect change
        this.onChange(this);
      }
    };

    function interpret(machine, onChange, initialContext, event) {
      let s = Object.create(service, {
        machine: valueEnumerableWritable(machine),
        context: valueEnumerableWritable(machine.context(initialContext, event)),
        onChange: valueEnumerable(onChange)
      });
      s.send = s.send.bind(s);
      s.machine = s.machine.state.value.enter(s.machine, s, event);
      return s;
    }

    // exports.action = action;
    // exports.createMachine = createMachine;
    // exports.d = d;
    // exports.guard = guard;
    // exports.immediate = immediate;
    // exports.interpret = interpret;
    // exports.invoke = invoke;
    // exports.reduce = reduce;
    // exports.state = state;
    // exports.transition = transition;

    const invokePromiseType = Object.getPrototypeOf(invoke(Promise.resolve()));

    function unknownState(from, state) {
      throw new Error(`Cannot transition from ${from} to unknown state: ${state}`);
    }

    d._create = function(current, states) {
      if(!(current in states)) {
        throw new Error(`Initial state [${current}] is not a known state.`);
      }
      for(let p in states) {
        let state = states[p];
        for(let [, candidates] of state.transitions) {
          for(let {to} of candidates) {
            if(!(to in states)) {
              unknownState(p, to);
            }
          }
        }
        if (invokePromiseType.isPrototypeOf(state)) {
          let hasErrorFrom = false;
          for(let [, candidates] of state.transitions) {
            for(let {from} of candidates) {
              if (from === 'error') hasErrorFrom = true;
            }
          }
          if(!hasErrorFrom) {
            console.warn(
              `When using invoke [current state: ${p}] with Promise-returning function, you need to add 'error' state. Otherwise, robot will hide errors in Promise-returning function`
            );
          }
        }
      }
    };

    d._send = function(eventName, currentStateName) {
      throw new Error(`No transitions for event ${eventName} from the current state [${currentStateName}]`);
    };

    const sec = 1000;
    const min = 60 * sec;
    const hour = 60 * min;
    const pad$1 = (n, p = "0") => n.toString().padStart(2, p);
    const makeTimeFormat$1 = (div, mod) => time => pad$1(Math.floor(time / div) % mod);
    const timeFormats$1 = [
        makeTimeFormat$1(hour, 24),
        makeTimeFormat$1(min, 60),
        makeTimeFormat$1(sec, 60),
        makeTimeFormat$1(1, 1000),
    ];
    const getTimeDisplays$1 = time => timeFormats$1.map(fn => fn(time));
    const update$1 = store => () => {
        const [hr, min, sec, ms] = getTimeDisplays$1((store.elapsed = Date.now() - store.start));
        store.display = `${hr}:${min}:${sec}:${ms}`;
    };
    const Timer = (mode = "default", opts) => {
        const timerStore = reactive({
            start: Date.now(),
            elapsed: 0,
            display: "00:00:00:00",
            mode,
            ...opts,
        });
        const attachTimer = html `<div id="timer">
    <div id="timer-display">${() => timerStore.display}</div>
  </div>`;
        const startTimer = (element, mode_override) => {
            if (mode_override)
                timerStore.mode = mode_override;
            console.log("starting timer mode:", timerStore.mode);
            const timerInterval = setInterval(update$1(timerStore), 100);
            attachTimer(element);
            return timerInterval;
        };
        return [startTimer, timerStore];
    };

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
    const Clock = (mode = "default", opts) => {
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
            const [count, sides] = dice.split("d").map(n => parseInt(n));
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
    const msgNext = (next, message, log) => (log && console.log(log),
        { message, next, timestamp: new Date().toLocaleString() });
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
        stop: app => {
            console.log('Stopping "app":', app);
            const appIndex = runningApps.findIndex(a => a.name === app);
            if (appIndex > -1) {
                clearInterval(runningApps[appIndex].interval);
                runningApps.splice(appIndex, 1);
                return `Stopped app: ${app}`;
            }
            else
                return msgNext("error", `Cannot stop unknown app: ${app}`);
        },
        goto: link => {
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
    const commandConsoleInterpreter = (message, ...args) => {
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
    const createCommandConsoleTemplate = (consoleId, inputId, outputId, store, handleKeyup) => {
        return html `<div
  id="${consoleId}"
  class="${() => store.mode}">
  <h5>Test: ${() => store.test}</h5>
  <ul id="${outputId}">
    ${() => store.output.map(line => html `<li class="${line.type}">
          <span class="timestamp">${line.timestamp}</span>
          ${line.display}
        </li>`)}
  </ul>
  <div id="prompt">
    <input
      autocomplete="off"
      id="${inputId}"
      type="text"
      @keyup="${handleKeyup}" />
  </div>
</div>`;
    };

    const reduceWithKeys = (ck, ek) => reduce((ctx, evt) => {
        return {
            ...ctx,
            ...(evt.data ? evt.data : { [ck]: evt[ek] }),
            ...(evt.error ? { error: evt.error } : { error: null }),
        };
    });
    const reduceSetKeyValue = (key, value) => reduce((ctx) => ({ ...ctx, [key]: value }));
    // Standard Transitions
    const onRejectStoreErrorThenGo = dst => transition("error", dst, reduceWithKeys("error", "error"));
    const onResolveMergeDataThenGo = dst => transition("done", dst, reduceWithKeys("data", "data"));
    const doThenElse = (fn, dst, err) => invoke(fn, onResolveMergeDataThenGo(dst), onRejectStoreErrorThenGo(err));
    // Guards
    const guardNext = next => guard((ctx) => ctx.next === next);
    const guardKeyZero = key => guard((ctx) => ctx[key] === 0);
    // Switch states have an array of immediate transitions with guards on the `next` context property
    const createSwitchState = (cases) => {
        const final = cases.pop();
        const transitions = cases.map(([dst, next]) => {
            next = next ?? dst;
            return immediate(dst, guardNext(next));
        });
        const switchState = state(...[...transitions, immediate(final)]);
        return switchState;
    };

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

})();
