import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import { test, expect } from "../../app/e2e/support/fixtures";
import { openSettings } from "../../app/e2e/support/helpers/app";
import { getE2EDaemonPort } from "../../app/e2e/support/helpers/daemon-port";
import { openFileExplorer, expectFileTabOpen } from "../../app/e2e/support/helpers/file-explorer";
import {
  clickSettingsBackToWorkspace,
  openSettingsSection,
} from "../../app/e2e/support/helpers/settings";

const pluginPath = process.env.PASEO_MARKDOWN_PREVIEW_PATH;
if (!pluginPath)
  throw new Error("Set PASEO_MARKDOWN_PREVIEW_PATH to the Markdown Preview plugin checkout.");
test.use({
  video: "off",
  launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  e2eDaemonConfig: {
    version: 1,
    pluginsEnabled: true,
    plugins: {
      "markdown-preview": { source: "directory", path: path.resolve(pluginPath), enabled: true },
    },
  },
});

const execFileAsync = promisify(execFile);
const visiblePreview = 'iframe[title="Markdown Preview Enhanced"]:visible';

async function manageIsolatedPlugin(action: "enable" | "disable") {
  const port = getE2EDaemonPort();
  const home = process.env.E2E_PASEO_HOME;
  if (!home) throw new Error("Plugin lifecycle tests require the isolated worker's Paseo home.");
  // Use the documented CLI and an explicit fixture endpoint. This cannot fall
  // through to the user's daemon or prepare/install into the plugin source.
  await execFileAsync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--",
      path.resolve(__dirname, "../../cli/src/index.ts"),
      "plugin",
      action,
      "markdown-preview",
      "--host",
      `127.0.0.1:${port}`,
      "--json",
    ],
    {
      cwd: path.resolve(__dirname, "../../.."),
      env: { ...process.env, PASEO_HOME: home },
      timeout: 30_000,
    },
  );
}

async function previewAddress(page: Page) {
  const address = await page.locator(visiblePreview).getAttribute("src");
  if (!address) throw new Error("The visible Markdown preview has no address.");
  return address;
}

async function closeFileTab(page: Page, filename: string) {
  const tab = page.getByTestId(`workspace-tab-file_${filename}`);
  await tab.click({ button: "right" });
  await page.getByTestId(`workspace-tab-context-file_${filename}-close`).click();
  await expect(tab).toHaveCount(0);
}

test("ordinary Markdown opens and right-click Preview render the selected document in its file tab", async ({
  page,
  withWorkspace,
}, testInfo) => {
  const workspace = await withWorkspace();
  await writeFile(path.join(workspace.repoPath, "README.md"), "# Readme sentinel\n");
  await writeFile(
    path.join(workspace.repoPath, "Selected & notes.md"),
    "# Selected notes\n\n- [ ] Persist the selected task\n\n```mermaid\ngraph LR\n A[Read]-->B[Preview]\n```\n",
  );
  await writeFile(
    path.join(workspace.repoPath, "Guide.markdown"),
    "# Context menu guide\n\nOpened directly from the selected file.\n",
  );
  await workspace.navigateTo();
  await openFileExplorer(page);
  const tree = page.getByTestId("file-explorer-tree-scroll");
  await tree.getByText("Selected & notes.md", { exact: true }).click();
  await expectFileTabOpen(page, "Selected & notes.md");
  const preview = page.frameLocator('iframe[title="Markdown Preview Enhanced"]').first();
  await expect(preview.getByRole("heading", { name: "Selected notes" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(preview.getByRole("heading", { name: "Readme sentinel" })).toHaveCount(0);
  await expect(preview.getByRole("combobox")).toBeHidden();
  await expect(preview.getByRole("img", { name: "Mermaid diagram" })).toBeVisible();
  await preview.getByRole("checkbox").check();
  await expect(preview.getByRole("checkbox")).toBeChecked();
  await page.getByTestId("file-mode-source").click();
  await expect(page.locator(".cm-content")).toContainText("[x] Persist the selected task");
  await tree.getByText("Selected & notes.md", { exact: true }).click({ button: "right" });
  await page.getByTestId(/file-explorer-row-\d+-preview$/).click();
  await expect(preview.getByRole("heading", { name: "Selected notes" })).toBeVisible();
  await expect(preview.getByRole("checkbox")).toBeChecked();
  await expect(page.getByTestId("workspace-tab-file_Selected & notes.md")).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("ordinary-markdown-preview.png") });

  await tree.getByText("Guide.markdown", { exact: true }).click({ button: "right" });
  await page.getByTestId(/file-explorer-row-\d+-preview$/).click();
  await expectFileTabOpen(page, "Guide.markdown");
  const guide = page.frameLocator('iframe[title="Markdown Preview Enhanced"]').last();
  await expect(guide.getByRole("heading", { name: "Context menu guide" })).toBeVisible();
  await expect(page.getByTestId("workspace-tab-file_Guide.markdown")).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("context-menu-markdown-preview.png") });
});

test("an unavailable plugin leaves Source accessible and Retry restores the same file tab", async ({
  page,
  withWorkspace,
}, testInfo) => {
  const workspace = await withWorkspace();
  await writeFile(path.join(workspace.repoPath, "Recovery.md"), "# Recovery document\n");
  await manageIsolatedPlugin("disable");
  try {
    await workspace.navigateTo();
    await openFileExplorer(page);
    await page
      .getByTestId("file-explorer-tree-scroll")
      .getByText("Recovery.md", { exact: true })
      .click();
    await expectFileTabOpen(page, "Recovery.md");
    await expect(page.getByText("Plugin is not available: markdown-preview")).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry preview" })).toBeVisible();
    await page.getByTestId("file-mode-source").click();
    await expect(page.locator(".cm-content")).toContainText("# Recovery document");
    await page.getByTestId("file-mode-preview").click();
    await expect(page.getByRole("button", { name: "Retry preview" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("unavailable-plugin-source-recovery.png") });
  } finally {
    await manageIsolatedPlugin("enable");
  }
  await page.getByRole("button", { name: "Retry preview" }).click();
  await expect(
    page.frameLocator(visiblePreview).getByRole("heading", { name: "Recovery document" }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Retry preview" })).toHaveCount(0);
  await expect(page.getByTestId("workspace-tab-file_Recovery.md")).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("retry-restored-markdown-preview.png") });
});

test("local links open ordinary tabs, source saves update live, and closing previews releases only their sessions", async ({
  page,
  request,
  withWorkspace,
}, testInfo) => {
  const workspace = await withWorkspace();
  const firstPath = path.join(workspace.repoPath, "First.md");
  await writeFile(firstPath, "# First document\n\n[Open companion](./Companion.markdown)\n");
  await writeFile(path.join(workspace.repoPath, "Companion.markdown"), "# Companion document\n");
  await workspace.navigateTo();
  await openFileExplorer(page);
  await page
    .getByTestId("file-explorer-tree-scroll")
    .getByText("First.md", { exact: true })
    .click();
  const first = page.frameLocator(visiblePreview);
  await expect(first.getByRole("heading", { name: "First document" })).toBeVisible({
    timeout: 30_000,
  });
  const firstAddress = await previewAddress(page);
  await first.getByRole("link", { name: "Open companion" }).click();
  await expectFileTabOpen(page, "Companion.markdown");
  const companion = page.frameLocator(visiblePreview);
  await expect(companion.getByRole("heading", { name: "Companion document" })).toBeVisible({
    timeout: 30_000,
  });
  const companionAddress = await previewAddress(page);
  expect(companionAddress).not.toBe(firstAddress);
  await expect(page.getByTestId("workspace-tab-file_First.md")).toHaveCount(1);
  await expect(page.getByTestId("workspace-tab-file_Companion.markdown")).toHaveCount(1);
  expect((await request.get(firstAddress)).status()).toBe(200);
  expect((await request.get(companionAddress)).status()).toBe(200);

  await page.getByTestId("workspace-tab-file_First.md").click({ position: { x: 12, y: 13 } });
  await expect(first.getByRole("heading", { name: "First document" })).toBeVisible();
  // An external editor save changes the real workspace file while its existing
  // preview stays mounted. The UI must update without a reload or another RPC open.
  await writeFile(
    firstPath,
    "# First document updated\n\n[Open companion](./Companion.markdown)\n",
  );
  await expect(first.getByRole("heading", { name: "First document updated" })).toBeVisible();
  expect(await previewAddress(page)).toBe(firstAddress);
  await page.screenshot({ path: testInfo.outputPath("linked-tabs-live-markdown.png") });

  await page
    .getByTestId("workspace-tab-file_Companion.markdown")
    .click({ position: { x: 12, y: 13 } });
  await expect(companion.getByRole("heading", { name: "Companion document" })).toBeVisible();
  await closeFileTab(page, "First.md");
  await expect.poll(async () => (await request.get(firstAddress)).status()).toBe(404);
  expect((await request.get(companionAddress)).status()).toBe(200);
  await expect(companion.getByRole("heading", { name: "Companion document" })).toBeVisible();
  await closeFileTab(page, "Companion.markdown");
  await expect.poll(async () => (await request.get(companionAddress)).status()).toBe(404);
});

test("Markdown previews follow Light and Dark selected through Appearance", async ({
  page,
  withWorkspace,
}) => {
  const workspace = await withWorkspace();
  await writeFile(path.join(workspace.repoPath, "Theme.md"), "# Theme document\n");
  await workspace.navigateTo();
  await openFileExplorer(page);
  await page
    .getByTestId("file-explorer-tree-scroll")
    .getByText("Theme.md", { exact: true })
    .click();
  await expect(
    page.frameLocator(visiblePreview).getByRole("heading", { name: "Theme document" }),
  ).toBeVisible({ timeout: 30_000 });
  for (const [label, scheme] of [
    ["Light", "light"],
    ["Dark", "dark"],
  ] as const) {
    await openSettings(page);
    await openSettingsSection(page, "appearance");
    await page.getByLabel(/^Theme: /).click();
    await page.getByText(label, { exact: true }).click();
    await expect(page.getByLabel(`Theme: ${label}`, { exact: true })).toBeVisible();
    await clickSettingsBackToWorkspace(page);
    await expectFileTabOpen(page, "Theme.md");
    const preview = page.frameLocator(visiblePreview);
    await expect(preview.getByRole("heading", { name: "Theme document" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(preview.locator("html")).toHaveCSS("color-scheme", scheme);
  }
});
