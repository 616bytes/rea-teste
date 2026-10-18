import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";

// Substitute only the native binding; public adapters and source acquisition run normally.
registerHooks({
  resolve(specifier, context, next) {
    return specifier === "frida"
      ? { url: import.meta.url, shortCircuit: true }
      : next(specifier, context);
  },
});

const signal = () => ({ connect() {}, disconnect() {} });
const createSession = () => {
  let closed = false;
  return {
    detached: signal(),
    isDetached: () => closed,
    async detach() {
      closed = true;
    },
    async createScript(source) {
      const digest = createHash("sha256").update(source).digest("hex");
      await writeFile(process.env.REA_FRIDA_TEST_SOURCE_LOG, digest);
      let listener;
      return {
        isDestroyed: false,
        message: {
          connect(handler) {
            listener = handler;
          },
          disconnect() {
            listener = undefined;
          },
        },
        async load() {
          listener?.(
            { type: "send", payload: { loaded_sha256: digest } },
            null,
          );
        },
        async unload() {
          this.isDestroyed = true;
        },
      };
    },
  };
};

const device = {
  id: "local",
  name: "Simulated source-acquisition device",
  type: "local",
  async getProcessByPid(pid) {
    return { pid, name: "fixture" };
  },
  async attach() {
    return createSession();
  },
};

export const getDeviceManager = () => ({
  async getDeviceById() {
    return device;
  },
});
