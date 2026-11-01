// #457: the coarse stage of a running theme-on-demand run, from its jobs.
//
// The page shows what is really happening instead of a timer. Only the job
// names and states are read (no logs, no actor); the stage names are the
// public vocabulary of the progress bar, not internal job names.

export type RunStage = "queued" | "generate" | "check" | "publish";

// Job order of theme-on-demand.yml (the `upgrade` job after publication is
// not part of the wait).
const ORDER: ReadonlyArray<{ name: string; stage: RunStage }> = [
  { name: "generate", stage: "generate" },
  { name: "promote", stage: "check" },
  { name: "release / validate", stage: "check" },
  { name: "release / build", stage: "publish" },
  { name: "release / admit", stage: "publish" },
  { name: "release / deploy", stage: "publish" },
  { name: "release / smoke", stage: "publish" },
  { name: "release / record", stage: "publish" },
];

interface JobLike {
  name?: unknown;
  status?: unknown;
  conclusion?: unknown;
}

/** The stage of the first job (in workflow order) that has not finished.
 * No job started yet -> "queued"; every known job finished -> "publish"
 * (the page then waits for the manifest). Unknown shapes -> null. */
export function stageFromJobs(jobs: unknown): RunStage | null {
  if (!Array.isArray(jobs)) return null;
  const byName = new Map<string, JobLike>();
  for (const j of jobs as JobLike[]) {
    if (j && typeof j.name === "string") byName.set(j.name, j);
  }
  if (byName.size === 0) return "queued";
  const generate = byName.get("generate");
  if (generate && generate.status === "queued") return "queued";
  for (const { name, stage } of ORDER) {
    const j = byName.get(name);
    if (!j) return stage; // not created yet: the previous job just finished
    if (j.status !== "completed") return stage;
  }
  return "publish";
}
