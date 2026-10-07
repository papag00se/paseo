import {
  IDBKeyRange as FakeIDBKeyRange,
  IDBObjectStore as FakeIDBObjectStore,
  indexedDB as fakeIndexedDb,
} from "fake-indexeddb";
import { expect, it, vi } from "vitest";
import { runReplicaRowStoreContract } from "./row-store.contract";
import { createIndexedDbReplicaRowStore } from "./row-store.web";

globalThis.indexedDB = fakeIndexedDb;
globalThis.IDBKeyRange = FakeIDBKeyRange;

let databaseSequence = 0;

runReplicaRowStoreContract("IndexedDB", async () => {
  const databaseName = `replica-row-store-test-${databaseSequence++}`;
  return {
    store: createIndexedDbReplicaRowStore({ databaseName, schemaVersion: 1 }),
    async openWithSchemaVersion(schemaVersion) {
      const store = createIndexedDbReplicaRowStore({ databaseName, schemaVersion });
      await store.open();
      return store;
    },
  };
});

it("handles an aborted read without leaking a rejected transaction promise", async () => {
  const store = createIndexedDbReplicaRowStore({
    databaseName: `replica-row-store-aborted-${databaseSequence++}`,
    schemaVersion: 1,
  });
  await store.open();
  const originalGetAll = FakeIDBObjectStore.prototype.getAll;
  const getAll = vi.spyOn(FakeIDBObjectStore.prototype, "getAll").mockImplementation(function (
    this: InstanceType<typeof FakeIDBObjectStore>,
    ...args
  ) {
    this.transaction.abort();
    return originalGetAll.apply(this, args);
  });
  try {
    await expect(store.readAll()).rejects.toThrow();
    await expect(store.read("server-a", ["agent"])).rejects.toThrow();
    // Drain actual IndexedDB abort events, not just promise microtasks.
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    getAll.mockRestore();
  }
  expect(await store.readAll()).toEqual([]);
});

it("uses exact IndexedDB keys for targeted rows instead of scanning the host", async () => {
  const store = createIndexedDbReplicaRowStore({
    databaseName: `replica-row-store-targeted-${databaseSequence++}`,
    schemaVersion: 1,
  });
  await store.open();
  await store.apply({
    upserts: [
      { serverId: "server-a", kind: "agent", id: "agent-1", payload: "agent" },
      { serverId: "server-a", kind: "workspace", id: "workspace-1", payload: "workspace" },
    ],
    deletes: [],
  });
  const get = vi.spyOn(FakeIDBObjectStore.prototype, "get");
  const getAll = vi.spyOn(FakeIDBObjectStore.prototype, "getAll");

  expect(await store.read("server-a", ["agent"], ["agent-1"])).toEqual([
    { serverId: "server-a", kind: "agent", id: "agent-1", payload: "agent" },
  ]);
  expect(get).toHaveBeenCalledWith(["server-a", "agent", "agent-1"]);
  expect(getAll).not.toHaveBeenCalled();

  get.mockRestore();
  getAll.mockRestore();
});
