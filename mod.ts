const enum Flags {
	RUNNING = 1 << 0,
	DIRTY = 1 << 1,
	MAYBE_DIRTY = 1 << 2,
	TRACKING = 1 << 3,
	NOTIFIED = 1 << 4,
	DISPOSED = 1 << 5,
	HAS_ERROR = 1 << 6,
}

type Computation = Computed<any> | Effect<any>;

/** @internal currently evaluating listener */
export let eval_listener: Computation | undefined;

/** pointer for checking existing dependencies in a context */
let eval_sources_index: number = 0;
/** array of new dependencies to said context */
let eval_untracked_sources: Signal[] | undefined;

/** effect scheduled for batching */
let batched_effect: Effect<any> | undefined;
/** current batch depth */
let batch_depth: number = 0;
/** current batch iteration */
let batch_iteration: number = 0;

/**
 * Writing to a signal ticks this write clock forward and stores the new epoch
 * into that signal, this is used for contexts to know if they're stale by
 * comparing the epoch between it and its dependencies.
 */
let write_clock = 0;

/**
 * Running a context ticks this read clock forward and stores the new epoch
 * into that context, this is used for duplicate-checking to see if the signal
 * has already been read by the context.
 *
 * Oversubscription isn't a big deal at all so really this isn't actually
 * needed, a duplicate dependency wouldn't cause any harm as we have a flag for
 * checking whether the context has been already been notified.
 */
let read_clock = 0;

function start_batch(): void {
	batch_depth++;
}

function end_batch(): void {
	if (batch_depth > 1) {
		batch_depth--;
		return;
	}

	let error: unknown;
	let has_error = false;

	while (batched_effect !== undefined) {
		let effect: Effect | undefined = batched_effect;
		batched_effect = undefined;

		batch_iteration++;

		while (effect !== undefined) {
			const next: Effect | undefined = effect._next_batched_effect;
			const flags = (effect._flags &= ~Flags.NOTIFIED);
			effect._next_batched_effect = undefined;

			if (!(flags & Flags.DISPOSED) && is_stale(effect, flags)) {
				try {
					effect._refresh();
				} catch (err) {
					if (!has_error) {
						has_error = true;
						error = err;
					}
				}
			}

			effect = next;
		}
	}

	batch_iteration = 0;
	batch_depth--;

	if (has_error) {
		throw error;
	}
}

function is_stale(target: Computation, flags: number): boolean {
	const dependencies = target._dependencies;

	if (flags & Flags.DIRTY) {
		return true;
	}

	if (flags & Flags.MAYBE_DIRTY) {
		for (let i = 0, ilen = dependencies.length; i < ilen; i++) {
			const source = dependencies[i];

			if (source._epoch > target._epoch || source._refresh()) {
				return true;
			}
		}
	}

	return false;
}

function cleanup_context(): void {
	let dependencies = eval_listener!._dependencies;

	if (eval_untracked_sources) {
		// We have new dependencies, so let's unsubscribe from stale dependencies.
		prune_context_sources();

		if (eval_sources_index > 0) {
			// We have existing dependencies still depended on, so let's expand the
			// existing array to make room for our new dependencies.
			const ilen = eval_untracked_sources.length;

			dependencies.length = eval_sources_index + ilen;

			// Override anything after the pointer with our new dependencies, this is
			// fine since we're no longer subscribed to them.
			for (let i = 0; i < ilen; i++) {
				dependencies[eval_sources_index + i] = eval_untracked_sources[i];
			}
		} else {
			// There isn't any existing dependencies, so just replace the existing
			// array with the new one.
			dependencies = eval_listener!._dependencies = eval_untracked_sources;
		}

		// Now we subscribe to the new dependencies, but only if we're currently
		// configured as tracking.
		if (eval_listener!._flags & Flags.TRACKING) {
			for (let i = eval_sources_index, ilen = dependencies.length; i < ilen; i++) {
				const dep = dependencies[i];

				dep._subscribe(eval_listener!);
			}
		}
	} else if (eval_sources_index < eval_listener!._dependencies.length) {
		// We don't have new dependencies, but the index pointer isn't pointing to
		// the end of the array, so we need to clean up the rest.
		prune_context_sources();
		dependencies.length = eval_sources_index;
	}
}

function prune_context_sources(): void {
	const dependencies = eval_listener!._dependencies;

	for (let i = 0, ilen = dependencies.length; i < ilen; i++) {
		const dep = dependencies[i];
		dep._unsubscribe(eval_listener!);
	}
}

function cleanup_effect(effect: Effect<any>): void {
	const cleanups = effect._cleanups;
	if (cleanups.length > 0) {
		const prev_listener = eval_listener;

		/*#__INLINE__*/ start_batch();
		eval_listener = undefined;

		try {
			for (let i = 0, ilen = cleanups.length; i < ilen; i++) {
				(0, cleanups[i])();
			}
		} catch (err) {
			// Failed to clean, so let's dispose of this effect.
			effect._flags = (effect._flags & ~Flags.RUNNING) | Flags.DISPOSED;
			dispose_effect(effect, false);

			throw err;
		} finally {
			cleanups.length = 0;

			eval_listener = prev_listener;

			end_batch();
		}
	}
}

function dispose_effect(effect: Effect<any>, run_cleanup: boolean): void {
	const dependencies = effect._dependencies;

	for (let i = 0, ilen = dependencies.length; i < ilen; i++) {
		const dep = dependencies[i];
		dep._unsubscribe(effect);
	}

	dependencies.length = 0;

	if (run_cleanup) {
		cleanup_effect(effect);
	}
}

export class Signal<T = unknown> {
	/** @internal Stored time of the write clock */
	_epoch = -1;
	/** @internal Stored time of the read clock, used to detect dupe-reads */
	_access_epoch = -1;
	/** @internal Contexts depending on it */
	_dependants: Computation[] = [];

	/** @internal stored value */
	_value: T;

	constructor(value: T) {
		this._value = value;
	}

	/**
	 * @internal
	 * Contexts will call this function to check if perhaps its dependencies are
	 * stale, this is mostly needed for computed signals though, for a signal,
	 * there's nothing new to be had once this method is called.
	 */
	_refresh(): boolean {
		// Returning `true` indicates that the dependant is now stale as a result,
		// e.g. computation has returned a different value. This just prevents the
		// need to check the epoch again so the epoch still needs to be incremented.
		return false;
	}

	/** @internal */
	_subscribe(target: Computation): void {
		this._dependants.push(target);
	}

	/** @internal */
	_unsubscribe(target: Computation): void {
		const dependants = this._dependants;
		const index = dependants.indexOf(target);

		dependants.splice(index, 1);
	}

	/**
	 * Retrieves the value without being tracked as a dependant.
	 */
	peek(): T {
		return this._value;
	}

	/**
	 * Retrieves the value, tracks the currently-running effect as a dependant.
	 */
	get value(): T {
		// Check if we're running under a context
		if (eval_listener !== undefined && eval_listener._context_epoch !== this._access_epoch) {
			// Store the read epoch, we don't need to recheck the dependencies of
			// this effect.
			this._access_epoch = eval_listener._context_epoch;

			// Dependency tracking is simple: does the index pointer point to us?
			//
			// - If so, then we're already depended on and we can increment the
			//   pointer for the next signal.
			//
			// - If not, then we need to create a new dependency array and stop
			//   incrementing the pointer, now that pointer acts as a dividing line
			//   between signals that are still being depended, and are no longer
			//   depended upon. The new dependencies can be concatenated afterwards.

			if (eval_untracked_sources !== undefined) {
				eval_untracked_sources.push(this);
			} else if (eval_listener._dependencies[eval_sources_index] === this) {
				eval_sources_index++;
			} else {
				eval_untracked_sources = [this];
			}
		}

		return this._value;
	}
	set value(next: T) {
		if (this._value !== next) {
			// Tick the write clock forward
			this._epoch = ++write_clock;
			this._value = next;

			if (batch_iteration < 100) {
				const dependants = this._dependants;

				/*#__INLINE__*/ start_batch();

				for (let i = 0, ilen = dependants.length; i < ilen; i++) {
					const dep = dependants[i];

					// Source signal dependants are guaranteed to be dirty.
					dep._notify(Flags.DIRTY);
				}

				end_batch();
			}
		}
	}
}

export interface ReadonlySignal<T> extends Signal<T> {
	readonly value: T;
}

export class Computed<T = unknown> extends Signal<T> {
	/**
	 * @internal
	 * Signals it's depending on
	 */
	_dependencies: Signal[] = [];
	/**
	 * @internal
	 * Context flags
	 */
	_flags: number = Flags.DIRTY;
	/**
	 * @internal
	 * This is mostly used for computed signals that currently aren't being
	 * subscribed to, if nothing in the realm has changed, then it shouldn't be
	 * possible for this computed signal to be stale from its dependencies.
	 */
	_realm_write_epoch = -1;
	/**
	 * @internal
	 * Stored time of the read clock
	 */
	_context_epoch = -1;

	/**
	 * @internal
	 * Compute function used to retrieve the value for this computed signal
	 */
	_compute: (prev: T) => T;

	constructor(compute: (prev: T) => T, initialValue: T) {
		super(initialValue);

		this._compute = compute;
	}

	/** @internal */
	_refresh(): boolean {
		// Retrieve the current flags, make sure to unset NOTIFIED now that we're
		// running this refresh.
		const flags = (this._flags &= ~Flags.NOTIFIED);

		if (
			// If our stored time matches current time then nothing in the realm has changed
			this._realm_write_epoch === write_clock ||
			// If we're tracking, we can make use of DIRTY and MAYBE_DIRTY
			(flags & (Flags.TRACKING | Flags.DIRTY | Flags.MAYBE_DIRTY)) === Flags.TRACKING ||
			// Prevent self-referential checks
			flags & Flags.RUNNING
		) {
			return false;
		}

		this._flags = (flags & ~Flags.DIRTY & ~Flags.MAYBE_DIRTY) | Flags.RUNNING;
		this._realm_write_epoch = write_clock;

		if (this._epoch > -1 && !is_stale(this, flags)) {
			this._flags &= ~Flags.RUNNING;
			return false;
		}

		const prev_value = this._value;
		const prev_listener = eval_listener;
		const prev_sources = eval_untracked_sources;
		const prev_sources_index = eval_sources_index;

		let stale = false;
		let value: T;

		try {
			this._context_epoch = read_clock++;

			eval_listener = this;
			eval_untracked_sources = undefined;
			eval_sources_index = 0;

			value = (0, this._compute)(prev_value);

			if (flags & Flags.HAS_ERROR || prev_value !== value || this._epoch === -1) {
				stale = true;

				this._value = value;
				this._flags &= ~Flags.HAS_ERROR;
				this._epoch = this._realm_write_epoch = ++write_clock;
			}
		} catch (err) {
			// Always mark errors as stale
			stale = true;

			this._value = err as T;
			this._flags |= Flags.HAS_ERROR;
			this._epoch = this._realm_write_epoch = ++write_clock;
		}

		cleanup_context();

		eval_listener = prev_listener;
		eval_untracked_sources = prev_sources;
		eval_sources_index = prev_sources_index;

		this._flags &= ~Flags.RUNNING;
		return stale;
	}

	/** @internal */
	_subscribe(target: Computation): void {
		// Subscribe to our sources now that we have someone subscribing on us
		if (this._dependants.length < 1) {
			const dependencies = this._dependencies;
			this._flags |= Flags.TRACKING;

			for (let i = 0, ilen = dependencies.length; i < ilen; i++) {
				const dep = dependencies[i];
				dep._subscribe(this);
			}
		}

		super._subscribe(target);
	}

	/** @internal */
	_unsubscribe(target: Computation): void {
		super._unsubscribe(target);

		// Unsubscribe from our sources since there's no one subscribing to us
		if (this._dependants.length < 1) {
			const dependencies = this._dependencies;
			this._flags &= ~Flags.TRACKING;

			for (let i = 0, ilen = dependencies.length; i < ilen; i++) {
				const dep = dependencies[i];
				dep._unsubscribe(this);
			}
		}
	}

	/** @internal */
	_notify(flag: Flags.DIRTY | Flags.MAYBE_DIRTY): void {
		if (!(this._flags & (Flags.NOTIFIED | Flags.RUNNING))) {
			const dependants = this._dependants;

			this._flags |= flag | Flags.NOTIFIED;

			for (let i = 0, ilen = dependants.length; i < ilen; i++) {
				const dep = dependants[i];

				// Computed signal dependants aren't guaranteed to be dirty.
				dep._notify(Flags.MAYBE_DIRTY);
			}
		}
	}

	/**
	 * Retrieves the value without being tracked as a dependant
	 */
	peek(): T {
		this._refresh();

		if (this._flags & Flags.HAS_ERROR) {
			throw this._value;
		}

		return this._value;
	}

	/**
	 * Retrieves the value, tracks the currently-running effect as a dependant
	 */
	get value(): T {
		this._refresh();

		if (this._flags & Flags.HAS_ERROR) {
			throw super.value;
		}

		return super.value;
	}
}

type CleanupFunction = () => void;

export class Effect<T = void> {
	/** @internal Stored time of the write clock */
	_epoch = -1;
	/** @internal Stored time of the read clock */
	_context_epoch = -1;
	/** @internal Signals it's depending on */
	_dependencies: Signal[] = [];
	/** @internal Context flags */
	_flags = Flags.TRACKING;

	/** @internal Registered cleanup functions */
	_cleanups: CleanupFunction[] = [];
	/** @internal Compute function for this effect */
	_compute: (prev: T) => T;
	/** @internal Stored value from this compute */
	_value!: T;

	/** @internal Batched effects are queued by a linked list on itself */
	_next_batched_effect: Effect | undefined;

	constructor(compute: (prev: T) => T, initialValue: T) {
		this._compute = compute;
		this._value = initialValue;
	}

	/** @internal */
	_refresh() {
		const flags = this._flags;

		if (flags & Flags.RUNNING) {
			return;
		}

		const prev_listener = eval_listener;
		const prev_sources = eval_untracked_sources;
		const prev_sources_index = eval_sources_index;

		try {
			/*#__INLINE__*/ start_batch();

			eval_listener = this;
			eval_untracked_sources = undefined;
			eval_sources_index = 0;

			this._epoch = write_clock;
			this._context_epoch = read_clock++;
			this._flags = (flags & ~Flags.DIRTY & ~Flags.MAYBE_DIRTY) | Flags.RUNNING;

			this._value = (0, this._compute)(this._value);
		} finally {
			cleanup_context();

			eval_listener = prev_listener;
			eval_untracked_sources = prev_sources;
			eval_sources_index = prev_sources_index;

			if ((this._flags &= ~Flags.RUNNING) & Flags.DISPOSED) {
				dispose_effect(this, true);
			}

			end_batch();
		}
	}

	/** @internal */
	_notify(flag: Flags.DIRTY | Flags.MAYBE_DIRTY): void {
		if (!(this._flags & (Flags.NOTIFIED | Flags.RUNNING))) {
			this._flags |= flag | Flags.NOTIFIED;
			this._next_batched_effect = batched_effect;
			batched_effect = this;
		}
	}

	/** @internal */
	_dispose(): void {
		if (!((this._flags |= Flags.DISPOSED) & Flags.RUNNING)) {
			dispose_effect(this, true);
		}
	}
}

/**
 * Create a new signal, a container that can change value and subscribed to at
 * any given time.
 */
export function signal<T>(): Signal<T | undefined>;
export function signal<T>(value: T): Signal<T>;
export function signal<T>(value?: T): Signal<T | undefined> {
	return new Signal(value);
}

type NoInfer<T extends any> = [T][T extends any ? 0 : never];

/**
 * The compute function itself.
 */
export type ComputedFunction<Prev, Next extends Prev = Prev> = (v: Prev) => Next;

/**
 * Create derivations of signals.
 */
export function computed<Next extends Prev, Prev = Next>(
	fn: ComputedFunction<undefined | NoInfer<Prev>, Next>,
): ReadonlySignal<Next>;
export function computed<Next extends Prev, Init = Next, Prev = Next>(
	fn: ComputedFunction<Init | Prev, Next>,
	value: Init,
): ReadonlySignal<Next>;
export function computed<Next extends Prev, Init, Prev>(
	fn: ComputedFunction<Init | Prev, Next>,
	value?: Init,
): ReadonlySignal<Next> {
	// @ts-expect-error: messy overloads
	return new Computed(fn, value);
}

/**
 * The effect function itself.
 */
export type EffectFunction<Prev, Next extends Prev = Prev> = (v: Prev) => Next;

/**
 * Run side-effects that get rerun when one of its signal dependencies change.
 */
export function effect<Next extends Prev, Prev = Next>(
	fn: EffectFunction<undefined | NoInfer<Prev>, Next>,
): void;
export function effect<Next extends Prev, Init = Next, Prev = Next>(
	fn: EffectFunction<Init | Prev, Next>,
	value: Init,
): void;
export function effect<Next extends Prev, Init, Prev>(
	fn: EffectFunction<Init | Prev, Next>,
	value?: Init,
): void {
	// @ts-expect-error - messy overloads
	const instance = new Effect(fn, value);

	try {
		instance._refresh();
	} catch (err) {
		instance._dispose();
		throw err;
	}
}

/**
 * Adds a cleanup function that gets run when an effect is rerun or destroyed
 * @param fn Cleanup function to run
 * @param throws Whether to throw if not under an effect, defaults to true
 */
export function cleanup(fn: () => void, throws = true) {
	if (eval_listener instanceof Effect) {
		eval_listener._cleanups.push(fn);
	} else if (throws) {
		throw new Error(`Cleanup function called outside of effect`);
	}
}

/**
 * Read signal values without being tracked as a dependency
 */
export function untrack<T>(callback: () => T): T {
	if (eval_listener === undefined) {
		return callback();
	}

	const prev_listener = eval_listener;
	eval_listener = undefined;

	try {
		return callback();
	} finally {
		eval_listener = prev_listener;
	}
}

/**
 * Combines multiple signal writes into one single update that gets triggered at
 * the end of the callback
 */
export function batch(callback: () => void): void {
	if (batch_depth > 0) {
		return callback();
	}

	/* @__INLINE__ */ start_batch();

	try {
		return callback();
	} finally {
		end_batch();
	}
}
