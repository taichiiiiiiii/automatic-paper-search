import { describe, expect, it } from "vitest";
import { stageFromJobs } from "../../src/lib/run-stage.js";

const job = (name: string, status: string, conclusion: string | null = null) => ({
  name,
  status,
  conclusion,
});

describe("stageFromJobs (#457)", () => {
  it("is queued before any job exists or while generate waits for a runner", () => {
    expect(stageFromJobs([])).toBe("queued");
    expect(stageFromJobs([job("generate", "queued")])).toBe("queued");
  });

  it("is generate while the generate job runs", () => {
    expect(stageFromJobs([job("generate", "in_progress")])).toBe("generate");
  });

  it("is check from promote to validate", () => {
    expect(stageFromJobs([job("generate", "completed", "success")])).toBe("check");
    expect(
      stageFromJobs([
        job("generate", "completed", "success"),
        job("promote", "completed", "success"),
        job("release / validate", "in_progress"),
      ]),
    ).toBe("check");
  });

  it("is publish from build to record, and after the last job", () => {
    const done = (n: string) => job(n, "completed", "success");
    const upto = ["generate", "promote", "release / validate"].map(done);
    expect(stageFromJobs([...upto, job("release / build", "in_progress")])).toBe("publish");
    expect(
      stageFromJobs(
        [
          ...upto,
          "release / build",
          "release / admit",
          "release / deploy",
          "release / smoke",
          "release / record",
        ].map((n) => (typeof n === "string" ? done(n) : n)),
      ),
    ).toBe("publish");
  });

  it("ignores the upgrade job and unknown shapes", () => {
    expect(stageFromJobs([job("generate", "in_progress"), job("upgrade", "queued")])).toBe(
      "generate",
    );
    expect(stageFromJobs(null)).toBeNull();
    expect(stageFromJobs("x")).toBeNull();
  });
});
