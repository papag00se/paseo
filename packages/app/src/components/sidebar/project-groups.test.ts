import { describe, expect, it } from "vitest";
import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";
import { partitionSidebarProjects } from "./project-groups-model";

function project(viewKey: string): SidebarProjectEntry {
  return { viewKey } as SidebarProjectEntry;
}

function sectionSummary(section: ReturnType<typeof partitionSidebarProjects>[number]) {
  return {
    id: section.group?.id ?? null,
    projects: section.projects.map((entry) => entry.viewKey),
  };
}

describe("partitionSidebarProjects", () => {
  it("places projects under their configured groups and keeps unknown assignments ungrouped", () => {
    const sections = partitionSidebarProjects({
      projects: [project("alpha"), project("beta"), project("gamma")],
      groups: [
        { id: "work", name: "Work", iconUri: null },
        { id: "play", name: "Play", iconUri: "https://example.com/icon.png" },
      ],
      groupIdByProjectViewKey: {
        alpha: "work",
        beta: "missing",
        gamma: "play",
      },
    });

    expect(sections.map(sectionSummary)).toEqual([
      { id: "work", projects: ["alpha"] },
      { id: "play", projects: ["gamma"] },
      { id: null, projects: ["beta"] },
    ]);
  });

  it("keeps empty named groups so they remain editable", () => {
    const sections = partitionSidebarProjects({
      projects: [],
      groups: [{ id: "empty", name: "Empty", iconUri: null }],
      groupIdByProjectViewKey: {},
    });

    expect(sections[0]).toEqual({
      group: { id: "empty", name: "Empty", iconUri: null },
      projects: [],
    });
  });
});
