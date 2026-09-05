import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSidebarProjectGroupsStore } from "./sidebar-project-groups-store";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}));

beforeEach(() => {
  useSidebarProjectGroupsStore.setState({
    groups: [],
    groupIdByProjectViewKey: {},
    collapsedGroupIds: new Set(),
    editorTarget: null,
    assignmentProjectViewKey: null,
  });
});

describe("sidebar project groups store", () => {
  it("creates, edits, assigns, and removes a group without touching projects", () => {
    const id = useSidebarProjectGroupsStore.getState().createGroup({ name: "  Work  " });
    useSidebarProjectGroupsStore.getState().assignProject("project-a", id);
    useSidebarProjectGroupsStore.getState().updateGroup(id, {
      name: "Clients",
      iconUri: "https://example.com/client.png",
    });

    expect(useSidebarProjectGroupsStore.getState().groups).toEqual([
      { id, name: "Clients", iconUri: "https://example.com/client.png" },
    ]);
    expect(useSidebarProjectGroupsStore.getState().groupIdByProjectViewKey).toEqual({
      "project-a": id,
    });

    useSidebarProjectGroupsStore.getState().deleteGroup(id);
    expect(useSidebarProjectGroupsStore.getState().groups).toEqual([]);
    expect(useSidebarProjectGroupsStore.getState().groupIdByProjectViewKey).toEqual({});
  });

  it("moves a project between a group and Ungrouped", () => {
    const id = useSidebarProjectGroupsStore.getState().createGroup({ name: "Work" });
    const store = useSidebarProjectGroupsStore.getState();
    store.assignProject("project-a", id);
    expect(useSidebarProjectGroupsStore.getState().groupIdByProjectViewKey["project-a"]).toBe(id);

    store.assignProject("project-a", null);
    expect(
      useSidebarProjectGroupsStore.getState().groupIdByProjectViewKey["project-a"],
    ).toBeUndefined();
  });

  it("rejects blank names and ignores unknown group assignments", () => {
    expect(() => useSidebarProjectGroupsStore.getState().createGroup({ name: "  " })).toThrow(
      "Group name is required",
    );
    useSidebarProjectGroupsStore.getState().assignProject("project-a", "missing");
    expect(useSidebarProjectGroupsStore.getState().groupIdByProjectViewKey).toEqual({});
  });
});
