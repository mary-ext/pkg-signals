# signals

Fast reactive signals.

```ts
const name = signal(`Mary`);

// Run a side effect that gets rerun on state changes...
effect(() => {
	console.log(`Hello, ${name.value}!`);
});
// logs `Hello, Mary!`

// Combine multiple writes into a single update...
batch(() => {
	name.value = `Elly`;
	name.value = `Alice!`;
});
// logs `Hello, Alice!`

// Run derivations that only gets updated as needed when not depended on...
const doubled = computed(() => {
	console.log(`Computation ran!`);
	return name.repeat(2);
});

doubled.value;
// logs `Computation ran!`
// -> `AliceAlice`

name.value = `Alina`;
// no logs as it's not being read under an effect yet!

doubled.value;
// logs `Computation ran!`
// -> `AlinaAlina`
```
