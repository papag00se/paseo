import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

export interface SidebarProjectGroup {
  id: string;
  name: string;
  iconUri: string | null;
}

interface SidebarProjectGroupsState {
  groups: SidebarProjectGroup[];
  groupIdByProjectViewKey: Record<string, string>;
  collapsedGroupIds: Set<string>;
  editorTarget: "new" | string | null;
  assignmentProjectViewKey: string | null;
  openEditor: (target: "new" | string) => void;
  closeEditor: () => void;
  openAssignment: (projectViewKey: string) => void;
  closeAssignment: () => void;
  createGroup: (input: { name: string; iconUri?: string | null }) => string;
  updateGroup: (id: string, input: { name: string; iconUri?: string | null }) => void;
  deleteGroup: (id: string) => void;
  reorderGroups: (orderedGroupIds: string[]) => void;
  assignProject: (projectViewKey: string, groupId: string | null) => void;
  toggleGroupCollapsed: (id: string) => void;
}

const SidebarProjectGroupSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  iconUri: z.string().nullable(),
});

const PersistedSidebarProjectGroupsSchema = z.strictObject({
  groups: z.array(SidebarProjectGroupSchema).optional(),
  groupIdByProjectViewKey: z.record(z.string(), z.string()).optional(),
  collapsedGroupIds: z.array(z.string()).optional(),
});

function normalizeName(name: string): string {
  return name.trim().slice(0, 80);
}

function normalizeIconUri(iconUri: string | null | undefined): string | null {
  const normalized = iconUri?.trim() ?? "";
  return normalized ? normalized.slice(0, 700_000) : null;
}

function createGroupId(): string {
  return `group_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function mergeSidebarProjectGroupsState(
  persisted: unknown,
  current: SidebarProjectGroupsState,
): SidebarProjectGroupsState {
  const parsed = PersistedSidebarProjectGroupsSchema.safeParse(persisted);
  if (!parsed.success) return current;
  const groups = parsed.data.groups ?? [];
  const groupIds = new Set(groups.map(({ id }) => id));
  const groupIdByProjectViewKey = Object.fromEntries(
    Object.entries(parsed.data.groupIdByProjectViewKey ?? {}).filter(
      ([projectViewKey, groupId]) => projectViewKey.trim() && groupIds.has(groupId),
    ),
  );
  return {
    ...current,
    groups,
    groupIdByProjectViewKey,
    collapsedGroupIds: new Set(
      (parsed.data.collapsedGroupIds ?? []).filter((id) => groupIds.has(id)),
    ),
  };
}

export const useSidebarProjectGroupsStore = create<SidebarProjectGroupsState>()(
  persist(
    (set) => ({
      groups: [],
      groupIdByProjectViewKey: {},
      collapsedGroupIds: new Set(),
      editorTarget: null,
      assignmentProjectViewKey: null,
      openEditor: (target) => set({ editorTarget: target }),
      closeEditor: () => set({ editorTarget: null }),
      openAssignment: (projectViewKey) => set({ assignmentProjectViewKey: projectViewKey }),
      closeAssignment: () => set({ assignmentProjectViewKey: null }),
      createGroup: ({ name, iconUri }) => {
        const normalizedName = normalizeName(name);
        if (!normalizedName) throw new Error("Group name is required");
        const id = createGroupId();
        set((state) => ({
          groups: [
            ...state.groups,
            { id, name: normalizedName, iconUri: normalizeIconUri(iconUri) },
          ],
        }));
        return id;
      },
      updateGroup: (id, { name, iconUri }) => {
        const normalizedName = normalizeName(name);
        if (!normalizedName) throw new Error("Group name is required");
        set((state) => ({
          groups: state.groups.map((group) =>
            group.id === id
              ? { ...group, name: normalizedName, iconUri: normalizeIconUri(iconUri) }
              : group,
          ),
        }));
      },
      deleteGroup: (id) => {
        set((state) => ({
          groups: state.groups.filter((group) => group.id !== id),
          groupIdByProjectViewKey: Object.fromEntries(
            Object.entries(state.groupIdByProjectViewKey).filter(([, groupId]) => groupId !== id),
          ),
          collapsedGroupIds: new Set(
            [...state.collapsedGroupIds].filter((groupId) => groupId !== id),
          ),
        }));
      },
      reorderGroups: (orderedGroupIds) => {
        set((state) => {
          const groupsById = new Map(state.groups.map((group) => [group.id, group]));
          const seen = new Set<string>();
          const reordered = orderedGroupIds.flatMap((id) => {
            const group = groupsById.get(id);
            if (!group || seen.has(id)) return [];
            seen.add(id);
            return [group];
          });
          for (const group of state.groups) {
            if (!seen.has(group.id)) reordered.push(group);
          }
          return { groups: reordered };
        });
      },
      assignProject: (projectViewKey, groupId) => {
        set((state) => {
          const next = { ...state.groupIdByProjectViewKey };
          if (groupId === null || !state.groups.some(({ id }) => id === groupId)) {
            delete next[projectViewKey];
          } else {
            next[projectViewKey] = groupId;
          }
          return { groupIdByProjectViewKey: next };
        });
      },
      toggleGroupCollapsed: (id) => {
        set((state) => {
          const next = new Set(state.collapsedGroupIds);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return { collapsedGroupIds: next };
        });
      },
    }),
    {
      name: "sidebar-project-groups",
      storage: createValidatedPersistStorage(AsyncStorage, PersistedSidebarProjectGroupsSchema),
      partialize: (state) => ({
        groups: state.groups,
        groupIdByProjectViewKey: state.groupIdByProjectViewKey,
        collapsedGroupIds: [...state.collapsedGroupIds],
      }),
      merge: mergeSidebarProjectGroupsState,
      version: 1,
    },
  ),
);
