"use client";

import type { Relation } from "../../../lib/lineage/v2/constants";
/**
 * The display/scope/advanced-filter controls -- ported from
 * docs/lineage/index.html's `<section class="lineage-focus__controls">`
 * + docs/assets/lineage-focus.js `renderControls`/`buildRelationOptions`/
 * `buildEvidenceOptions`/the change-event bindings in `bindEvents`.
 *
 * Every control is "controlled": it reflects `state` and calls
 * `onPatch` with exactly the field(s) docs/assets/lineage-focus.js's
 * corresponding listener passed to `normalizeAndProject`. The parent
 * (FocusView) owns re-deriving/validating the resulting state through
 * `writeState`/`readState`/`selectFocusProjection` -- this component
 * never computes a "final" state itself.
 */
import { RELATION_LABELS } from "../../../lib/lineage/v2/layout";
import type { FocusViewState } from "../../../lib/lineage/v2/state";
import styles from "./focus.module.css";

const RELATIONS: Relation[] = [
  "supersedes",
  "successor",
  "extends",
  "ablation",
  "baseline_only",
  "contrasts",
];

export interface ControlsProps {
  state: FocusViewState;
  effectiveView: "graph" | "list";
  evidenceSources: string[];
  evidenceKinds: string[];
  onPatch: (patch: Partial<FocusViewState>) => void;
}

export function Controls({
  state,
  effectiveView,
  evidenceSources,
  evidenceKinds,
  onPatch,
}: ControlsProps) {
  const advancedActive =
    state.minConfidence !== 0.7 ||
    state.trustTiers.includes("tentative") ||
    state.families.length !== 1 ||
    state.families[0] !== "genealogy" ||
    state.relationFilterExplicit ||
    state.evidenceSourcesExplicit ||
    state.evidenceKindsExplicit;

  function toggleRelation(relation: Relation, checked: boolean) {
    const relations = checked
      ? [...state.relations, relation]
      : state.relations.filter((item) => item !== relation);
    onPatch({ relations, relationFilterExplicit: true });
  }

  function toggleEvidence(
    kind: "evidenceSources" | "evidenceKinds",
    value: string,
    checked: boolean,
  ) {
    const current = state[kind];
    const next = checked ? [...current, value] : current.filter((item) => item !== value);
    onPatch(
      kind === "evidenceSources"
        ? { evidenceSources: next, evidenceSourcesExplicit: true }
        : { evidenceKinds: next, evidenceKindsExplicit: true },
    );
  }

  return (
    <section className={styles.controls} aria-label="系譜の表示条件">
      <fieldset>
        <legend>表示</legend>
        <button
          type="button"
          aria-pressed={effectiveView === "graph"}
          onClick={() => onPatch({ view: "graph" })}
        >
          グラフ
        </button>
        <button
          type="button"
          aria-pressed={effectiveView === "list"}
          onClick={() => onPatch({ view: "list" })}
        >
          関係一覧
        </button>
      </fieldset>

      <label>
        範囲
        <select
          value={String(state.hops)}
          onChange={(event) => onPatch({ hops: Number(event.target.value) as 1 | 2 | 3 })}
        >
          <option value="1">直接の関係だけ</option>
          <option value="2">2段先まで</option>
          <option value="3">3段先まで</option>
        </select>
      </label>

      <label>
        論文数の上限
        <input
          type="number"
          min={5}
          max={50}
          step={1}
          value={state.nodeLimit}
          onChange={(event) => onPatch({ nodeLimit: Number(event.target.value) })}
        />
      </label>

      <details className={styles.advanced} open={advancedActive || undefined}>
        <summary>{advancedActive ? "詳細な絞り込み（適用中）" : "詳細な絞り込み"}</summary>
        <div className={styles.advancedBody}>
          <label>
            較正済み確率の下限
            <select
              value={String(state.minConfidence)}
              onChange={(event) =>
                onPatch({ minConfidence: Number(event.target.value) as 0.5 | 0.7 | 0.9 })
              }
            >
              <option value="0.5">0.50</option>
              <option value="0.7">0.70</option>
              <option value="0.9">0.90</option>
            </select>
            <small className={styles.smallPrint}>
              人手検証済みで確率未設定の関係は除外しません
            </small>
          </label>

          <fieldset className={styles.optionGroup}>
            <legend>判定</legend>
            <label>
              <input
                type="checkbox"
                checked={state.trustTiers.includes("tentative")}
                onChange={(event) =>
                  onPatch({
                    trustTiers: event.target.checked
                      ? (["verified", "corroborated", "tentative"] as const).slice()
                      : (["verified", "corroborated"] as const).slice(),
                  })
                }
              />{" "}
              要確認を表示
            </label>
          </fieldset>

          <fieldset className={styles.optionGroup}>
            <legend>関係族</legend>
            <label>
              <input
                type="checkbox"
                checked={state.families.includes("genealogy")}
                onChange={(event) => {
                  const families = event.target.checked
                    ? [...state.families, "genealogy" as const]
                    : state.families.filter((family) => family !== "genealogy");
                  onPatch({ families });
                }}
              />{" "}
              継承
            </label>
            <label>
              <input
                type="checkbox"
                checked={state.families.includes("comparison")}
                onChange={(event) => {
                  const families = event.target.checked
                    ? [...state.families, "comparison" as const]
                    : state.families.filter((family) => family !== "comparison");
                  onPatch({ families });
                }}
              />{" "}
              比較
            </label>
          </fieldset>

          <fieldset className={styles.optionGroup}>
            <legend>関係タイプ</legend>
            <div>
              {RELATIONS.map((relation) => (
                <label key={relation}>
                  <input
                    type="checkbox"
                    checked={state.relations.includes(relation)}
                    onChange={(event) => toggleRelation(relation, event.target.checked)}
                  />{" "}
                  {RELATION_LABELS[relation]}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className={styles.optionGroup}>
            <legend>根拠ソース</legend>
            <div>
              {evidenceSources.map((source) => (
                <label key={source}>
                  <input
                    type="checkbox"
                    checked={
                      !state.evidenceSourcesExplicit || state.evidenceSources.includes(source)
                    }
                    onChange={(event) =>
                      toggleEvidence("evidenceSources", source, event.target.checked)
                    }
                  />{" "}
                  {source}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className={styles.optionGroup}>
            <legend>根拠の種類</legend>
            <div>
              {evidenceKinds.map((kind) => (
                <label key={kind}>
                  <input
                    type="checkbox"
                    checked={!state.evidenceKindsExplicit || state.evidenceKinds.includes(kind)}
                    onChange={(event) =>
                      toggleEvidence("evidenceKinds", kind, event.target.checked)
                    }
                  />{" "}
                  {kind}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      </details>
    </section>
  );
}
