import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { SidebarProjectGroup } from "@/stores/sidebar-project-groups-store";

export interface SidebarProjectGroupSection {
  group: SidebarProjectGroup | null;
  projects: SidebarProjectEntry[];
}

export function partitionSidebarProjects(input: {
  projects: readonly SidebarProjectEntry[];
  groups: readonly SidebarProjectGroup[];
  groupIdByProjectViewKey: Readonly<Record<string, string>>;
}): SidebarProjectGroupSection[] {
  const byGroupId = new Map(
    input.groups.map((group) => [group.id, { group, projects: [] as SidebarProjectEntry[] }]),
  );
  const ungrouped: SidebarProjectEntry[] = [];
  for (const project of input.projects) {
    const groupId = input.groupIdByProjectViewKey[project.viewKey];
    const section = groupId ? byGroupId.get(groupId) : undefined;
    if (section) section.projects.push(project);
    else ungrouped.push(project);
  }
  return [
    ...input.groups.map((group) => byGroupId.get(group.id)!),
    { group: null, projects: ungrouped },
  ];
}
