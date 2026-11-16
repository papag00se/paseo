import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ProjectMomentumSchema, type ProjectMomentum } from "@getpaseo/protocol/messages";

const FILE_SCHEMA = z.object({
  version: z.literal(1),
  projects: z.record(z.string(), ProjectMomentumSchema),
});

const projectMomentumFile = (paseoHome: string) =>
  path.join(paseoHome, "momentum", "projects.json");

async function readProjects(file: string): Promise<Record<string, ProjectMomentum>> {
  try {
    return FILE_SCHEMA.parse(JSON.parse(await readFile(file, "utf8"))).projects;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

/** Reads one project's summary. The daemon's ProjectMomentumCache is the only writer. */
export async function readProjectMomentum(
  paseoHome: string,
  projectId: string,
): Promise<ProjectMomentum | null> {
  return (await readProjects(projectMomentumFile(paseoHome)))[projectId] ?? null;
}

/**
 * One summary per project, kept apart from agent records so it survives every agent in the project
 * being archived or deleted.
 */
export class ProjectMomentumCache {
  private projects: Record<string, ProjectMomentum> | null = null;
  private writes: Promise<void> = Promise.resolve();
  private readonly file: string;

  constructor(paseoHome: string) {
    this.file = projectMomentumFile(paseoHome);
  }

  private async load(): Promise<Record<string, ProjectMomentum>> {
    this.projects ??= await readProjects(this.file);
    return this.projects;
  }

  async get(projectId: string): Promise<ProjectMomentum | null> {
    return (await this.load())[projectId] ?? null;
  }

  /** Stores the summary unless the cache already holds a newer one for the project. */
  async set(entry: ProjectMomentum): Promise<void> {
    const projects = await this.load();
    const existing = projects[entry.projectId];
    if (existing && Date.parse(existing.generatedAt) > Date.parse(entry.generatedAt)) return;
    projects[entry.projectId] = entry;
    const body = JSON.stringify({ version: 1, projects });
    const previous = this.writes;
    this.writes = (async () => {
      await previous.catch(() => undefined);
      await mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      await writeFile(temp, body);
      await rename(temp, this.file);
    })();
    await this.writes;
  }
}
