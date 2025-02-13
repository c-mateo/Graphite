// import { panicProxy } from "@graphite/utility-functions/panic-proxy";
import { type JsMessageType } from "@graphite/messages";
import { createSubscriptionRouter, type SubscriptionRouter } from "@graphite/subscription-router";
import init, { setRandomSeed, wasmMemory, EditorHandle } from "@graphite-frontend/wasm/pkg/graphite_wasm.js";

export type Editor = {
	raw: WebAssembly.Memory;
	handle: EditorHandle;
	subscriptions: SubscriptionRouter;
};

// `wasmImport` starts uninitialized because its initialization needs to occur asynchronously, and thus needs to occur by manually calling and awaiting `initWasm()`
let wasmImport: WebAssembly.Memory | undefined;

const tauri = "__TAURI_METADATA__" in window && import("@tauri-apps/api");
export async function dispatchTauri(message: unknown) {
	if (!tauri) return;
	try {
		const response = await (await tauri).invoke("handle_message", { message });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(window as any).editorInstance?.tauriResponse(response);
	} catch {
		// eslint-disable-next-line no-console
		console.error("Failed to dispatch Tauri message");
	}
}

// Should be called asynchronously before `createEditor()`.
export async function initWasm() {
	// Skip if the WASM module is already initialized
	if (wasmImport !== undefined) return;

	// Import the WASM module JS bindings and wrap them in the panic proxy
	// eslint-disable-next-line import/no-cycle
	const wasm = await init();
	for (const [name, f] of Object.entries(wasm)) {
		if (name.startsWith("__node_registry")) f();
	}

	wasmImport = await wasmMemory();
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(window as any).imageCanvases = {};

	// Provide a random starter seed which must occur after initializing the WASM module, since WASM can't generate its own random numbers
	const randomSeedFloat = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
	const randomSeed = BigInt(randomSeedFloat);
	setRandomSeed(randomSeed);
	// if (!tauri) return;
	// await (await tauri).invoke("set_random_seed", { seed: randomSeedFloat });
}

// Should be called after running `initWasm()` and its promise resolving.
export function createEditor(): Editor {
	// Raw: object containing several callable functions from `editor_api.rs` defined directly on the WASM module, not the `EditorHandle` struct (generated by wasm-bindgen)
	if (!wasmImport) throw new Error("Editor WASM backend was not initialized at application startup");
	const raw: WebAssembly.Memory = wasmImport;

	// Handle: object containing many functions from `editor_api.rs` that are part of the `EditorHandle` struct (generated by wasm-bindgen)
	const handle: EditorHandle = new EditorHandle((messageType: JsMessageType, messageData: Record<string, unknown>) => {
		// This callback is called by WASM when a FrontendMessage is received from the WASM wrapper `EditorHandle`
		// We pass along the first two arguments then add our own `raw` and `handle` context for the last two arguments
		subscriptions.handleJsMessage(messageType, messageData, raw, handle);
	});

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(window as any).editorHandle = handle;

	// Subscriptions: allows subscribing to messages in JS that are sent from the WASM backend
	const subscriptions: SubscriptionRouter = createSubscriptionRouter();

	// Check if the URL hash fragment has any demo artwork to be loaded
	(async () => {
		const demoArtwork = window.location.hash.trim().match(/#demo\/(.*)/)?.[1];
		if (!demoArtwork) return;

		try {
			const url = new URL(`/${demoArtwork}.graphite`, document.location.href);
			const data = await fetch(url);
			if (!data.ok) throw new Error();

			const filename = url.pathname.split("/").pop() || "Untitled";
			const content = await data.text();
			handle.openDocumentFile(filename, content);

			// Remove the hash fragment from the URL
			history.replaceState("", "", `${window.location.pathname}${window.location.search}`);
		} catch {
			// Do nothing
		}
	})();

	return { raw, handle, subscriptions };
}

// TODO: Find a better way to do this, since no other code takes this approach.
// TODO: Then, delete the `(window as any).editorHandle = handle;` line above.
// This function is called by an FFI binding within the Rust code directly, rather than using the FrontendMessage system.
// Then, this directly calls the `injectImaginatePollServerStatus` function on the `EditorHandle` object which is a JS binding generated by wasm-bindgen, going straight back into the Rust code.
// export function injectImaginatePollServerStatus() {
// 	// eslint-disable-next-line @typescript-eslint/no-explicit-any
// 	(window as any).editorHandle?.injectImaginatePollServerStatus();
// }
