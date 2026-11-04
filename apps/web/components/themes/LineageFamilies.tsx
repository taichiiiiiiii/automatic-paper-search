"use client";

/**
 * #483: shows a family switcher above the tree when the lineage holds two
 * citation communities (see lib/themes-families.ts) and hands the tree
 * only the chosen family. Nothing is removed from the artifact: "すべて"
 * shows the whole graph as before.
 */
import { type ReactNode, useMemo, useState } from "react";
import { detectFamilies, familyLabel, initialFamily } from "../../lib/themes-families";
import type { LineageArtifact } from "../../lib/themes-quality";

export function familyArtifact(
  artifact: LineageArtifact,
  ids: Set<string> | null,
): LineageArtifact {
  if (ids === null) return artifact;
  return {
    ...artifact,
    root: artifact.root !== null && ids.has(artifact.root) ? artifact.root : null,
    nodes: artifact.nodes.filter((n) => ids.has(n.id)),
    edges: artifact.edges.filter((e) => ids.has(e.src) && ids.has(e.dst)),
  };
}

export function LineageFamilies({
  artifact,
  children,
}: {
  artifact: LineageArtifact;
  children: (shown: LineageArtifact, familyKey: string) => ReactNode;
}) {
  const families = useMemo(() => {
    const seeds = Array.isArray(artifact.meta?.seeds)
      ? (artifact.meta.seeds as unknown[]).filter((s): s is string => typeof s === "string")
      : [];
    return detectFamilies(artifact.nodes, artifact.edges, seeds);
  }, [artifact]);
  const [chosen, setChosen] = useState<number>(() =>
    families && typeof window !== "undefined" ? initialFamily(families, window.location.search) : 1,
  );
  const ids = families && chosen > 0 ? (families[chosen - 1]?.nodeIds ?? null) : null;
  const shown = useMemo(() => familyArtifact(artifact, ids), [artifact, ids]);

  if (!families) return <>{children(artifact, "all")}</>;

  const choose = (n: number) => {
    setChosen(n);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("fam", String(n));
      url.searchParams.delete("node");
      window.history.replaceState(null, "", url.toString());
    } catch {
      /* history unavailable: the switch still works for this view */
    }
  };

  return (
    <>
      <fieldset
        data-lineage-families
        className="mt-4 rounded-md border border-rule bg-surface-2 px-3 py-2 text-sm"
      >
        <legend className="px-1 text-xs text-ink-muted">
          この系譜には引用のつながりが別々の {families.length}{" "}
          つの系統があります（同じテーマ名が別の意味で使われています）
        </legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2" role="radiogroup">
          {families.map((f) => (
            <label key={f.index} className="inline-flex min-h-[44px] items-center gap-2">
              <input
                type="radio"
                name="lineage-family"
                value={f.index}
                checked={chosen === f.index}
                onChange={() => choose(f.index)}
                data-family={f.index}
              />
              <span>{familyLabel(f)}</span>
            </label>
          ))}
          <label className="inline-flex min-h-[44px] items-center gap-2">
            <input
              type="radio"
              name="lineage-family"
              value={0}
              checked={chosen === 0}
              onChange={() => choose(0)}
              data-family={0}
            />
            <span>すべて（{artifact.nodes.length} 本）</span>
          </label>
        </div>
      </fieldset>
      {children(shown, `fam-${chosen}`)}
    </>
  );
}
