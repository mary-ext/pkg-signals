/**
 * @module
 * Creates a reactive proxy of an object.
 * Loosely based off Svelte's and Solid's reactivity proxy implementation.
 */

import { batch, eval_listener, type Signal, signal } from './mod.ts';

interface ObjectMetadata {
	_is_array: boolean;
	_self: Signal<any>;
	_values: Record<string | symbol, Signal<any> | undefined>;
}

let uid = 0;

const METADATA_SYMBOL = /*#__PURE__*/ Symbol('reactive-metadata');
const RAW_SYMBOL = /*#__PURE__*/ Symbol('reactive-raw');

const UNINITIALIZED = /*#__PURE__*/ Symbol('reactive-uninitialized');

const deep_proxies = /*#__PURE__*/ new WeakSet<object>();

const object_to_shallow = /*#__PURE__*/ new WeakMap<object, any>();
const object_to_deep = /*#__PURE__*/ new WeakMap<object, any>();

const object_proto = /*#__PURE__*/ Object.prototype;
const array_proto = /*#__PURE__*/ Array.prototype;
const get_prototype_of = /*#__PURE__*/ Object.getPrototypeOf;
const get_descriptor = /*#__PURE__*/ Object.getOwnPropertyDescriptor;
const is_extensible = /*#__PURE__*/ Object.isExtensible;

const proxy_handler: ProxyHandler<any> = {
	get(target, prop, receiver) {
		if (prop === RAW_SYMBOL) {
			return target;
		}

		// deno-lint-ignore prefer-const
		let metadata: ObjectMetadata = target[METADATA_SYMBOL];
		let s = metadata._values[prop];

		if (s === undefined && eval_listener && (!(prop in target) || get_descriptor(target, prop)?.writable)) {
			s = metadata._values[prop] = signal(target[prop]);
		}

		if (s !== undefined) {
			const value = s.value;
			const is_deep_proxy = deep_proxies.has(receiver);
			return value === UNINITIALIZED ? undefined : is_deep_proxy ? reactive(value) : value;
		}

		return target[prop];
	},

	has(target, prop) {
		const metadata: ObjectMetadata = target[METADATA_SYMBOL];
		const has = prop in target;

		let s = metadata._values[prop];

		if (s !== undefined || (eval_listener && (!has || get_descriptor(target, prop)?.writable))) {
			if (s === undefined) {
				s = metadata._values[prop] = signal(has ? target[prop] : UNINITIALIZED);
			}

			if (s.value === UNINITIALIZED) {
				return false;
			}
		}

		return has;
	},

	set(target, prop, value) {
		const metadata: ObjectMetadata = target[METADATA_SYMBOL];

		const is_array = metadata._is_array;
		const not_has = !(prop in target);
		const s = metadata._values[prop];

		const unwrapped = unwrap(value);

		batch(() => {
			if (s !== undefined) {
				s.value = unwrapped;
			}

			if (is_array && prop === 'length') {
				for (let i = value, ilen = target.length; i < ilen; i++) {
					const cs = metadata._values[i];

					if (cs !== undefined) {
						cs.value = UNINITIALIZED;
					}
				}
			}

			target[prop] = unwrapped;

			if (not_has) {
				if (is_array) {
					const ls = metadata._values.length;

					if (ls !== undefined) {
						ls.value = target.length;
					}
				}

				metadata._self.value = uid++;
			}
		});

		return true;
	},

	defineProperty(target, prop, descriptor) {
		if ('value' in descriptor) {
			const metadata: ObjectMetadata = target[METADATA_SYMBOL];
			const s = metadata._values[prop];

			if (s !== undefined) {
				s.value = unwrap(descriptor.value);
			}
		}

		return Reflect.defineProperty(target, prop, descriptor);
	},

	deleteProperty(target, prop) {
		const metadata: ObjectMetadata = target[METADATA_SYMBOL];

		const is_array = metadata._is_array;
		const s = metadata._values[prop];

		const result = delete target[prop];

		batch(() => {
			if (is_array && result) {
				const ls = metadata._values.length;

				if (ls !== undefined) {
					ls.value = target.length - 1;
				}
			}

			if (s !== undefined) {
				s.value = UNINITIALIZED;
			}

			if (result) {
				metadata._self.value = uid++;
			}
		});

		return result;
	},

	getOwnPropertyDescriptor(target, prop) {
		const descriptor = Reflect.getOwnPropertyDescriptor(target, prop);
		if (descriptor && 'value' in descriptor) {
			const metadata: ObjectMetadata = target[METADATA_SYMBOL];
			const s = metadata._values[prop];

			if (s) {
				descriptor.value = s.value;
			}
		}

		return descriptor;
	},

	ownKeys(target) {
		if (eval_listener) {
			const metadata: ObjectMetadata = target[METADATA_SYMBOL];
			metadata._self.value;
		}

		return Reflect.ownKeys(target);
	},
};

function is_wrappable(obj: any): boolean {
	const proto = get_prototype_of(obj);
	return (proto === null || proto === object_proto || proto === array_proto) && is_extensible(obj);
}

function initialize(value: any): ObjectMetadata {
	return {
		_is_array: get_prototype_of(value) === array_proto,
		_self: signal(0),
		_values: Object.create(null),
	};
}

/**
 * Retrieve the original object from a reactive proxy
 * @param value Any value
 * @returns If a reactive proxy, the original object, otherwise returned as-is.
 */
export function unwrap<T>(value: T): T {
	if (typeof value === 'object' && value !== null) {
		// @ts-expect-error: wrong type
		return value[RAW_SYMBOL] ?? value;
	}

	return value;
}

/**
 * Creates a shallow reactive proxy of an object
 * @param value Any value
 * @returns If passed an object, a reactive proxy of that object, otherwise returned as-is.
 */
export function shallowReactive<T extends object>(value: T): T {
	if (typeof value === 'object' && value !== null && is_wrappable(value)) {
		let proxy = object_to_shallow.get(value = unwrap(value));

		if (proxy === undefined) {
			// @ts-expect-error: wrong type
			value[METADATA_SYMBOL] ||= initialize(value);

			object_to_shallow.set(value, proxy = new Proxy(value, proxy_handler));
		}

		return proxy;
	}

	return value;
}

/**
 * Creates a deep reactive proxy of an object
 * @param value Any value
 * @returns If passed an object, a reactive proxy of that object, otherwise returned as-is.
 */
export function reactive<T extends object>(value: T): T {
	if (typeof value === 'object' && value !== null && is_wrappable(value)) {
		let proxy = object_to_deep.get(value = unwrap(value));

		if (proxy === undefined) {
			// @ts-expect-error: wrong type
			value[METADATA_SYMBOL] ||= initialize(value);

			object_to_deep.set(value, proxy = new Proxy(value, proxy_handler));
			deep_proxies.add(proxy);
		}

		return proxy;
	}

	return value;
}
