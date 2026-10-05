import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect } from "../../app/e2e/support/fixtures";
import { openFileExplorer, expectFileTabOpen } from "../../app/e2e/support/helpers/file-explorer";

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
