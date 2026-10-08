import { describe, expect, it } from "vitest";
import { planWorkspaceOpenTargets, resolveParentDirectoryOpenInput } from "./planner";

const desktopTargets = [
  {
    id: "vscode",
    label: "VS Code",
    kind: "editor" as const,
    icon: { kind: "symbol" as const, name: "terminal" as const },
  },
  {
    id: "finder",
    label: "Finder",
    kind: "file-manager" as const,
    icon: { kind: "symbol" as const, name: "folder" as const },
  },
];

const checkoutStatus = {
  isGit: true,
  remoteUrl: "git@github.com:getpaseo/paseo.git",
  currentBranch: "main",
};

describe("planWorkspaceOpenTargets", () => {
  it("plans editor targets with active-file absolute path and cwd", () => {
    const targets = planWorkspaceOpenTargets({
      workspaceDirectory: "/repo",
      activeFile: { path: "src/app.ts", lineStart: 3, lineEnd: 5 },
      desktopTargets,
      canUseDesktopBridge: true,
      isLocalExecution: true,
    });

    expect(targets[0]).toMatchObject({
      source: "desktop",
      id: "vscode",
      openInput: {
        editorId: "vscode",
        workspacePath: "/repo",
        filePath: "/repo/src/app.ts",
        line: 3,
      },
    });
  });

  it("plans file-manager targets with active-file absolute path and reveal mode", () => {
    const targets = planWorkspaceOpenTargets({
      workspaceDirectory: "/repo",
      activeFile: { path: "src/app.ts" },
      desktopTargets,
      canUseDesktopBridge: true,
      isLocalExecution: true,
    });

    expect(targets[1]).toMatchObject({
      source: "desktop",
      id: "finder",
      openInput: {
        editorId: "finder",
        workspacePath: "/repo",
        filePath: "/repo/src/app.ts",
      },
    });
  });

  it("plans no active file as opening the workspace folder", () => {
    const targets = planWorkspaceOpenTargets({
      workspaceDirectory: "/repo",
      desktopTargets,
      canUseDesktopBridge: true,
      isLocalExecution: true,
    });

    expect(targets[0]).toMatchObject({
      source: "desktop",
      id: "vscode",
      openInput: { editorId: "vscode", workspacePath: "/repo" },
    });
    expect(targets[1]).toMatchObject({
      source: "desktop",
      id: "finder",
      openInput: { editorId: "finder", workspacePath: "/repo" },
    });
  });

  it("plans a nested directory as the editor workspace", () => {
    const targets = planWorkspaceOpenTargets({
      workspaceDirectory: "/specs",
      directoryPath: "repos/sample-android-app",
      desktopTargets: [
        {
          id: "android-studio",
          label: "Android Studio",
          kind: "editor",
          icon: { kind: "symbol", name: "terminal" },
        },
      ],
      canUseDesktopBridge: true,
      isLocalExecution: true,
    });

    expect(targets).toEqual([
      {
        source: "desktop",
        id: "android-studio",
        label: "Android Studio",
        editorId: "android-studio",
        icon: { kind: "symbol", name: "terminal" },
        openInput: {
          editorId: "android-studio",
          workspacePath: "/specs/repos/sample-android-app",
        },
      },
    ]);
  });

  it("passes custom target ids through as strings", () => {
    const targets = planWorkspaceOpenTargets({
      workspaceDirectory: "/repo",
      activeFile: { path: "src/app.ts" },
      desktopTargets: [
        {
          id: "script:open-in-nvim",
          label: "Open in Neovim",
          kind: "editor",
          icon: { kind: "symbol", name: "terminal" },
        },
      ],
      canUseDesktopBridge: true,
      isLocalExecution: true,
    });

    expect(targets).toEqual([
      {
        source: "desktop",
        id: "script:open-in-nvim",
        label: "Open in Neovim",
        editorId: "script:open-in-nvim",
        icon: { kind: "symbol", name: "terminal" },
        openInput: {
          editorId: "script:open-in-nvim",
          workspacePath: "/repo",
          filePath: "/repo/src/app.ts",
        },
      },
    ]);
  });

  it("keeps GitHub target independent and uses blob and tree URLs", () => {
    const blobTargets = planWorkspaceOpenTargets({
      workspaceDirectory: "/repo",
      activeFile: { path: "src/app.ts", lineStart: 3, lineEnd: 5 },
      desktopTargets: [],
      canUseDesktopBridge: false,
      isLocalExecution: false,
      checkoutStatus,
    });
    const treeTargets = planWorkspaceOpenTargets({
      workspaceDirectory: "/repo",
      desktopTargets: [],
      canUseDesktopBridge: false,
      isLocalExecution: false,
      checkoutStatus,
    });

    expect(blobTargets).toEqual([
      {
        source: "forge",
        forge: "github",
        id: "github",
        label: "GitHub",
        url: "https://github.com/getpaseo/paseo/blob/main/src/app.ts#L3-L5",
      },
    ]);
    expect(treeTargets).toEqual([
      {
        source: "forge",
        forge: "github",
        id: "github",
        label: "GitHub",
        url: "https://github.com/getpaseo/paseo/tree/main",
      },
    ]);
  });

  it("infers the forge from the remote URL when the forge input is null", () => {
    const targets = planWorkspaceOpenTargets({
      workspaceDirectory: "/repo",
      activeFile: { path: "src/app.ts", lineStart: 3, lineEnd: 5 },
      desktopTargets: [],
      canUseDesktopBridge: false,
      isLocalExecution: false,
      checkoutStatus: {
        isGit: true,
        remoteUrl: "git@gitlab.com:group/project.git",
        currentBranch: "main",
      },
      forge: null,
    });

    expect(targets).toEqual([
      {
        source: "forge",
        forge: "gitlab",
        id: "gitlab",
        label: "GitLab",
        url: "https://gitlab.com/group/project/-/blob/main/src/app.ts#L3-5",
      },
    ]);
  });

  it("suppresses desktop targets when Electron bridge is unavailable", () => {
    const targets = planWorkspaceOpenTargets({
      workspaceDirectory: "/repo",
      desktopTargets,
      canUseDesktopBridge: false,
      isLocalExecution: true,
      checkoutStatus,
    });

    expect(targets.map((target) => target.id)).toEqual(["github"]);
  });

  it("suppresses desktop targets for remote execution paths", () => {
    const targets = planWorkspaceOpenTargets({
      workspaceDirectory: "/repo",
      desktopTargets,
      canUseDesktopBridge: true,
      isLocalExecution: false,
      checkoutStatus,
    });

    expect(targets.map((target) => target.id)).toEqual(["github"]);
  });
});

describe("resolveParentDirectoryOpenInput", () => {
  it("returns the containing folder for nested relative and absolute paths", () => {
    expect(
      resolveParentDirectoryOpenInput({ path: "src/app/main.ts", workspaceDirectory: "/repo" }),
    ).toEqual({ directoryPath: "src/app" });
    expect(
      resolveParentDirectoryOpenInput({ path: "/repo/src/app", workspaceDirectory: "/repo" }),
    ).toEqual({ directoryPath: "src" });
  });

  it("opens the workspace root for top-level entries", () => {
    expect(
      resolveParentDirectoryOpenInput({ path: "README.md", workspaceDirectory: "/repo" }),
    ).toEqual({});
    expect(
      resolveParentDirectoryOpenInput({ path: "/repo/README.md", workspaceDirectory: "/repo" }),
    ).toEqual({});
  });

  it("refuses the workspace root itself and paths outside the workspace", () => {
    expect(resolveParentDirectoryOpenInput({ path: "/repo", workspaceDirectory: "/repo" })).toBe(
      null,
    );
    expect(
      resolveParentDirectoryOpenInput({ path: "/elsewhere/a/b.ts", workspaceDirectory: "/repo" }),
    ).toBe(null);
  });

  it("plans a desktop open of the parent folder", () => {
    const input = resolveParentDirectoryOpenInput({
      path: "src/app/main.ts",
      workspaceDirectory: "/repo",
    });
    const [target] = planWorkspaceOpenTargets({
      workspaceDirectory: "/repo",
      ...input,
      desktopTargets: desktopTargets.slice(0, 1),
      canUseDesktopBridge: true,
      isLocalExecution: true,
    });
    expect(target?.source === "desktop" ? target.openInput : null).toEqual({
      editorId: "vscode",
      workspacePath: "/repo/src/app",
    });
  });
});
