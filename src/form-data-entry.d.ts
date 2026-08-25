/**
 * @cloudflare/workers-types exposes FormData and File but not the DOM library's
 * global FormDataEntryValue alias. Keep the application signatures honest
 * without pulling the whole browser DOM library into the Worker build.
 */
type FormDataEntryValue = File | string;
