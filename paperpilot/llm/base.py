"""LLM provider abstraction (design doc §4.5).

Each provider implements evaluate_batch() to score a list of papers
against a research profile. The output follows a fixed schema
(PaperEvaluation) so callers are provider-agnostic.

Providers may *optionally* implement classify_relation() to classify how
one paper relates to another (used by `paperpilot/scripts/build_lineage.py`
to build the family-tree view). The default implementation returns None
so existing providers stay source-compatible; only providers that support
the feature override it.

The prompt design (system + user templates) is shared by all providers
so behavior is consistent regardless of which backend is used.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass

from ..models import Paper

# Bound LLM output strings so a runaway model can't bloat CSV / log files.
_MAX_SUMMARY_LEN = 500
_MAX_REASON_LEN = 200
_MAX_TAG_LEN = 32
_MAX_TAG_COUNT = 6


@dataclass
class PaperEvaluation:
    """Structured evaluation emitted by any LLM provider."""

    relevance: int  # 1 (irrelevant) .. 5 (must-read)
    summary_ja: str
    reason: str
    tags: list[str]

    @classmethod
    def from_dict(cls, d: object) -> PaperEvaluation | None:
        """Construct from a dict; return None when required fields are invalid."""
        if not isinstance(d, dict):
            return None
        rel = d.get("relevance")
        try:
            rel_int = int(rel) if rel is not None else None
        except (TypeError, ValueError, OverflowError):
            # OverflowError: int(float("inf")) / int(float("-inf")) raise
            # this (not ValueError). json.loads() accepts the non-standard
            # `Infinity`/`-Infinity` literals, so a malformed
            # `"relevance": Infinity` from an LLM response is a reachable
            # input, not just a theoretical one — must degrade to None like
            # any other invalid relevance, not raise past this validator.
            return None
        if rel_int is None or rel_int < 1 or rel_int > 5:
            return None
        summary = str(d.get("summary_ja") or "").strip()[:_MAX_SUMMARY_LEN]
        reason = str(d.get("reason") or "").strip()[:_MAX_REASON_LEN]
        tags_raw = d.get("tags") or []
        if isinstance(tags_raw, list):
            tags = [
                str(t).strip()[:_MAX_TAG_LEN]
                for t in tags_raw[:_MAX_TAG_COUNT]
                if t
            ]
        else:
            tags = []
        return cls(relevance=rel_int, summary_ja=summary, reason=reason, tags=tags)


def map_batch_evaluations(
    papers: list[Paper], parsed: object
) -> list[PaperEvaluation | None]:
    """Map a parsed LLM batch response back to `papers`, one result each.

    LLM summaries/relevance are untrusted derived data (AGENTS.md
    invariant), and a raw positional zip (`parsed[i]` <-> `papers[i]`) is
    unsafe: if the model's response array is short, reordered, has gaps,
    or duplicates an index, one paper's evaluation can silently attach to
    a different paper (closes #391). Every provider previously
    reimplemented the same unsafe zip independently; this is now the one
    shared, safe implementation.

    Matching is by the explicit `"index"` field each element must carry
    (1-based, matching the `[論文N]` numbering in build_evaluation_prompt).
    An index must be a strict `int` (not `bool` — `bool` is an `int`
    subclass in Python but never a meaningful index; not a float or
    numeric string coerced via `int(...)`, since that would silently
    accept malformed output like `1.5` or `"1"` as if it were exactly `1`)
    and within `[1, len(papers)]`. If the SAME index value appears on more
    than one element — regardless of whether either individual element is
    otherwise valid — that index is ambiguous and its evaluation is
    dropped entirely (mapped to None), never resolved by picking either
    claimant: a duplicate claim on one paper cannot be safely disambiguated
    by this function. A paper whose index never appears (or whose sole
    claiming element failed `PaperEvaluation.from_dict` validation) also
    gets None, the existing unknown/fallback value providers already
    return for a paper they can't evaluate.
    """
    if not isinstance(parsed, list):
        return [None] * len(papers)

    def _valid_index(item: object) -> int | None:
        if not isinstance(item, dict):
            return None
        raw_index = item.get("index")
        # Strict type check (not `int(raw_index)`): excludes bool (an int
        # subclass), float, and numeric strings, all of which `int()`
        # would silently coerce into a plausible-looking valid index.
        if type(raw_index) is not int:
            return None
        if raw_index < 1 or raw_index > len(papers):
            return None
        return raw_index

    # First pass: count how many elements claim each valid index. A count
    # of 2+ means the claim is ambiguous and must be rejected outright in
    # the second pass, regardless of either element's own field validity.
    index_counts: dict[int, int] = {}
    for item in parsed:
        index = _valid_index(item)
        if index is not None:
            index_counts[index] = index_counts.get(index, 0) + 1

    by_index: dict[int, PaperEvaluation] = {}
    for item in parsed:
        index = _valid_index(item)
        if index is None or index_counts[index] != 1:
            continue
        evaluation = PaperEvaluation.from_dict(item)
        if evaluation is not None:
            by_index[index] = evaluation

    return [by_index.get(i) for i in range(1, len(papers) + 1)]


SYSTEM_PROMPT = """\
あなたは学術論文の評価アシスタントです。
ユーザーの研究プロファイルに基づき、各論文の有用性を判定してください。

## 出力形式（厳守）
- JSON配列のみを返してください
- マークダウンのバッククォート（```）は絶対に含めないでください
- 各要素: {"index": int, "relevance": 1-5, "summary_ja": str, "reason": str, "tags": [str]}
- index: 評価対象の論文リストで示された番号（[論文1]なら1、[論文2]なら2、...）をそのまま設定してください
- relevance: 1=無関係, 2=弱い関連, 3=中程度, 4=強い関連, 5=必読
- summary_ja: 日本語で3行以内の要約
- reason: 日本語で1文、読むべき理由（無関係なら読まなくてよい理由）
- tags: 最大4個の日本語タグ（例: 「新手法」「ベンチマーク」「応用」「理論」）
- 全ての論文について1件ずつ評価を返してください（省略・重複禁止）
"""

_USER_TEMPLATE = """\
## あなたの研究プロファイル
{profile}

## 評価対象の論文（{count}件）
{papers_block}

各論文について、その番号を"index"に設定したJSON配列で評価してください。
"""


def build_evaluation_prompt(papers: list[Paper], profile: str) -> tuple[str, str]:
    """Return (system_prompt, user_prompt) for a batch of papers."""
    blocks: list[str] = []
    for i, p in enumerate(papers, start=1):
        abstract = (p.abstract or "")[:500]
        categories = ", ".join(p.categories) if p.categories else "-"
        venue = p.venue or "未査読"
        blocks.append(
            f"[論文{i}]\n"
            f"タイトル: {p.title}\n"
            f"カテゴリ: {categories}\n"
            f"学会: {venue}\n"
            f"GitHub Stars: {p.github_stars}\n"
            f"引用数: {p.citation_count}\n"
            f"アブストラクト: {abstract}"
        )
    user = _USER_TEMPLATE.format(
        profile=profile.strip() or "(プロファイル未設定: キーワード一致のみで判断)",
        count=len(papers),
        papers_block="\n\n".join(blocks),
    )
    return SYSTEM_PROMPT, user


# ---- Lineage relation classification (used by paperpilot/scripts/build_lineage.py) ----

_VALID_RELATIONS = frozenset(
    {
        "supersedes",
        "successor",
        "extends",
        "ablation",
        "baseline_only",
        "contrasts",
        "unrelated",
    }
)

_MAX_RATIONALE_LEN = 280
# Minimum rationale length (#297). A real rationale is a Japanese sentence
# of >=30 chars per CLASSIFY_SYSTEM_PROMPT's "30-200 chars" rule; 10 is a
# conservative "clearly degenerate" floor that catches the truncated LLM
# outputs seen in production ("A" / "QD" / "VLM" / "VLLM" / "CMA-ES" /
# "Qwen2-VL" / "P-GenRM") without over-rejecting borderline-valid short
# outputs. Rejecting here makes the caller's _apply_llm_classification fall
# back to the heuristic, which yields a full sentence — strictly better
# than a 1-char tooltip.
_MIN_RATIONALE_LEN = 10
_CLASSIFY_ABSTRACT_TRIM = 600

# Single source of truth for heuristic template rationales (#145 followup).
# Three consumers cross-reference these strings — they MUST stay in
# perfect byte-for-byte sync, so all three pull from this dict:
#   1. paperpilot.scripts.build_theme_lineage._INTENT_RELATION_MAP and
#      _derive_relation_heuristic emit them as the heuristic edges.
#   2. _GENERIC_TEMPLATE_RATIONALES (below) — reject set used by
#      RelationClassification.from_dict to catch LLM template echoes
#      (#131 second-line defence). Built from this dict's values.
#   3. CLASSIFY_SYSTEM_PROMPT MUST NOT block (first-line defence) —
#      currently lists 3 of these as forbidden outputs in plain text.
#      The test test_classify_prompt_forbids_template_phrasings pins
#      that fragments of the listed templates appear in the prompt.
#
# To add a new heuristic relation: add an entry here, reference it from
# build_theme_lineage, optionally add to the prompt's MUST NOT block.
TEMPLATE_RATIONALES: dict[str, str] = {
    "extends_methodology": "論文 B は論文 A の手法を異なる領域・タスク・スケールに拡張している。",
    "successor_result": "論文 B は論文 A の研究ラインを継承し自然に発展させている。",
    "baseline_only_background": "論文 B は論文 A をベースライン比較にのみ用いている。",
    "contrasts_year_cite": "論文 B は論文 A と根本的に異なるアプローチを提案している。",
    "supersedes_year_cite": "論文 B は論文 A の手法を置き換える改良版として提案されている。",
    "ablation_year_cite": "論文 B は論文 A の構成要素を分析・ablation している。",
}

# Reject set for LLM template echoes (#131). Derived from the dict so
# the two can't drift; if the LLM emits any of these, from_dict returns
# None and the caller's _apply_llm_classification falls back to the
# heuristic — same user-visible rationale, no false claim that the LLM
# added value.
_GENERIC_TEMPLATE_RATIONALES = frozenset(TEMPLATE_RATIONALES.values())


@dataclass
class RelationClassification:
    """How paper B relates to paper A, as classified by an LLM.

    Valid relations (design doc §5.5): supersedes / successor / extends /
    ablation / baseline_only / contrasts / unrelated.
    """

    relation: str
    confidence: float  # 0.0 .. 1.0
    rationale: str  # one short Japanese sentence (required — empty tooltips are worse than no edge)

    @classmethod
    def from_dict(cls, d: object) -> RelationClassification | None:
        if not isinstance(d, dict):
            return None
        rel = d.get("relation")
        if not isinstance(rel, str) or rel not in _VALID_RELATIONS:
            return None
        rationale = str(d.get("rationale") or "").strip()[:_MAX_RATIONALE_LEN]
        if not rationale:
            # An empty rationale would render an empty tooltip in the viewer.
            # Reject rather than emit a silent edge.
            return None
        if len(rationale) < _MIN_RATIONALE_LEN:
            # #297: a truncated LLM output like {"rationale":"A"} renders a
            # meaningless 1-char tooltip. Reject so the caller falls back to
            # the heuristic, which produces a full sentence.
            return None
        if rationale in _GENERIC_TEMPLATE_RATIONALES:
            # LLM regurgitated the heuristic template (see #131). Treat as
            # a failed classification — the caller's _apply_llm_classification
            # will then keep the heuristic edge, which has the same
            # user-visible rationale but doesn't claim LLM provenance.
            return None
        try:
            conf = float(d.get("confidence", 0.7))
        except (TypeError, ValueError):
            conf = 0.7
        # Clamp to [0, 1] — the UI treats confidence as an opacity multiplier.
        conf = max(0.0, min(1.0, conf))
        return cls(relation=rel, confidence=conf, rationale=rationale)


# Production traces showed Llama 3.3 70B would translate the prompt's
# English enum definitions into Japanese rather than reading the
# abstracts, producing byte-for-byte heuristic templates. The rewrite
# below (a) shortens the enum text so it can't be translated wholesale,
# (b) explicitly forbids the template phrasings as outputs, (c) shows
# one good example anchoring paper-specific style.
#
# Token budget note: kept under ~330 tokens (1,191 chars) because Groq's
# free tier caps at ~12,000 TPM. A larger prompt × 25 RPM (rate limiter
# default) would burn through the TPM budget and 429-throttle the back
# half of each burst, which was the regression observed in the #131
# first-cut rewrite (PR #132's first deploy got timed out at 8 min).
# Per-relation definitions (verbatim from docs/design/08-lineage-roadmap.md
# §関係種別ラベルの定義) + supersedes/ablation few-shot examples were added
# per #285: audit #286 showed supersedes=0 / ablation=0 across 452 calls
# because the prompt listed only the enum NAMES with no definitions, so the
# LLM could not distinguish the relations. The 1,200-char cap (test pin
# test_classify_prompt_within_groq_tpm_budget) still holds.
CLASSIFY_SYSTEM_PROMPT = """\
Compare two AI/ML papers (A older, B newer). Output ONLY JSON:
{"relation":"<one>","confidence":<0.0-1.0>,"rationale":"<one Japanese sentence>"}

relation values (pick one): supersedes / successor / extends / ablation / baseline_only / contrasts / unrelated
- supersedes: 同じアプローチで明確に性能を凌駕、基準論文を置き換える
- successor: 研究ラインの自然な発展、漸進的な改良
- extends: 同じ手法を別ドメイン・別タスク・別規模に応用
- ablation: 構成要素の寄与を分解測定する解析論文
- baseline_only: 比較対象として引用するだけで、知的な継承はない
- contrasts: 同じ問題に対する根本的に異なるアプローチ

rationale rules — read carefully, most errors are here:
- 30-200 chars, one Japanese sentence
- MUST mention a concrete concept from B's title or abstract (a method name, dataset, metric, or architectural choice), so the reader knows which two papers are compared.
- NEVER output these heuristic templates (emitting them wastes an LLM call):
  - "論文 B は論文 A の手法を異なる領域・タスク・スケールに拡張している"
  - "論文 B は論文 A の研究ラインを継承し自然に発展させている"
  - "論文 B は論文 A をベースライン比較にのみ用いている"

Examples (each names a concrete concept):
- extends: "B のグラフ畳み込み層は、A のスペクトル法を空間領域に再定式化し計算量を O(E) に落としている。"
- supersedes: "B (FlashAttention-2) は A と同じ exact attention のまま work partitioning を改良し2倍高速化、A を置き換える。"
- ablation: "B は A の各構成要素を取り除いて精度への寄与を分解測定している。"
"""

_CLASSIFY_USER_TEMPLATE = """\
PAPER A (older / target):
Title: {a_title}
Year: {a_year}
Abstract: {a_abstract}

PAPER B (newer / candidate):
Title: {b_title}
Year: {b_year}
Abstract: {b_abstract}

How does Paper B relate to Paper A?
"""


def build_classify_prompt(a: dict, b: dict) -> tuple[str, str]:
    """Return (system_prompt, user_prompt) for a single A→B relation classification.

    `a` / `b` are plain dicts (not `Paper`) so callers can pass S2 responses
    directly without adapting into the full pipeline schema.

    SECURITY (#300 review note): only `title`, `year`, and `abstract` are
    interpolated into the prompt — NEVER a prior `rationale` string. If a
    future change adds `rationale` (or any other free-text field a heuristic
    has written) to the prompt, attacker-controlled paper titles embedded
    in a slot-filled rationale (via `_slot_fill_rationale`) would become a
    prompt-injection vector. Add explicit sanitisation if extending.
    """
    user = _CLASSIFY_USER_TEMPLATE.format(
        a_title=a.get("title", ""),
        a_year=a.get("year", "?"),
        a_abstract=(a.get("abstract") or "")[:_CLASSIFY_ABSTRACT_TRIM],
        b_title=b.get("title", ""),
        b_year=b.get("year", "?"),
        b_abstract=(b.get("abstract") or "")[:_CLASSIFY_ABSTRACT_TRIM],
    )
    return CLASSIFY_SYSTEM_PROMPT, user


def provider_model_tag(provider: AbstractLLMProvider) -> str:
    """Stable 'name:model' tag for the LLM that produced a cached
    classification (#310), e.g. 'gemini:gemini-2.5-flash'. Cache metadata
    so mixed-provider caches stay auditable. Falls back to the provider
    name when .model is absent (base class / providers without a model).

    Concrete providers (GroqProvider / GeminiProvider) set ``self.model``
    plus a class-level ``name``; the abstract base has no ``.model``, so
    both reads go through ``getattr`` to stay total. The tag is NOT part
    of the cache key — it is recorded alongside the relation/confidence/
    rationale so a mixed-provider cache (post Groq→Gemini regen) can be
    attributed per producer.
    """
    name = getattr(provider, "name", "unknown")
    model = getattr(provider, "model", None)
    return f"{name}:{model}" if model else str(name)


class AbstractLLMProvider(ABC):
    """Contract every LLM backend must fulfil."""

    name: str = "abstract"

    def __init__(self, config: dict) -> None:
        # Initialize the secret slot first so subclass `enabled` properties
        # can safely reference `self._api_key` during base __init__.
        self._api_key: str | None = None
        self.config = config or {}
        self.enabled = bool(self.config.get("enabled", True))
        self.batch_size: int = int(self.config.get("batch_size", 5))
        self.timeout_seconds: float = float(self.config.get("timeout_seconds", 60))

    @abstractmethod
    def evaluate_batch(
        self, papers: list[Paper], profile: str
    ) -> list[PaperEvaluation | None]:
        """Evaluate a chunk of papers. Must return one result per input paper,
        preserving order. None for individual papers that could not be parsed.
        """

    def classify_relation(
        self, a: dict, b: dict
    ) -> RelationClassification | None:
        """Classify how paper B relates to paper A. Optional — providers that
        don't support lineage classification return None (the caller then
        falls back / skips the edge)."""
        return None

    def complete_json(self, system: str, user: str) -> str | None:
        """Return the model's RAW response text for a prompt that asks for a
        single JSON object, or None when the call failed.

        This exists because `classify_relation` parses and validates in one
        step, discarding a classification whose rationale is empty. The deep
        lineage builder deliberately relaxes that rule (#304: synthesize a
        slot-filled rationale rather than lose the whole subtree), so it has
        to see the relation BEFORE `RelationClassification.from_dict` runs.
        Reaching into a concrete provider's private `_chat` / `_generate` was
        how that was done previously, which crashed with AttributeError on
        every provider whose private method happened to be named differently.

        Providers with a JSON-mode single-shot completion override this.
        """
        raise NotImplementedError(
            f"{type(self).__name__} has no JSON-mode completion; it cannot be "
            "used for deep lineage classification."
        )
