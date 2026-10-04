// Small polyfills so the bundled pdf.js works in slightly older browsers.
// Loaded before pdf.js on the page and inside its worker.
for (const Ctor of [Map, WeakMap]) {
  const proto = Ctor.prototype;
  if (!proto.getOrInsert) {
    Object.defineProperty(proto, 'getOrInsert', {
      configurable: true,
      writable: true,
      value(key, value) {
        if (!this.has(key)) this.set(key, value);
        return this.get(key);
      },
    });
  }
  if (!proto.getOrInsertComputed) {
    Object.defineProperty(proto, 'getOrInsertComputed', {
      configurable: true,
      writable: true,
      value(key, compute) {
        if (!this.has(key)) this.set(key, compute(key));
        return this.get(key);
      },
    });
  }
}

if (!Promise.withResolvers) {
  Promise.withResolvers = function withResolvers() {
    let resolve;
    let reject;
    const promise = new this((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

if (!Promise.try) {
  Promise.try = function tryFn(fn, ...args) {
    return new this((resolve) => resolve(fn(...args)));
  };
}
