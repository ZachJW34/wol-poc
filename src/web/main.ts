import { mount, unmount } from "svelte";
import App from "./App.svelte";

const target = document.querySelector("#app");
if (!target) {
  throw new Error("Missing #app mount target in index.html");
}

const app = mount(App, { target });

export function destroy(): void {
  void unmount(app);
}
