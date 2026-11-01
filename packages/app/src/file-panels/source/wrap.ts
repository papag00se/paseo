/** Markdown is prose, so its paragraphs wrap by default; code keeps its lines. */
const WRAPPED_EXTENSIONS = new Set(["md", "markdown"]);

/**
 * Whether a Source view wraps long lines. Fork: the toolbar's Wrap toggle stores the user's
 * choice for every file; with no choice made, the file type decides.
 */
export function shouldWrapFile(filename: string, preference: boolean | null): boolean {
  if (preference !== null) return preference;
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  return WRAPPED_EXTENSIONS.has(extension);
}
