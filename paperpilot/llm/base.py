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
        except (TypeError, ValueError):
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


SYSTEM_PROMPT = """\
あなたは学術論文の評価アシスタントです。
ユーザーの研究プロファイルに基づき、各論文の有用性を判定してください。

## 出力形式（厳守）
- JSON配列のみを返してください
- マークダウンのバッククォート（```）は絶対に含めないでください
- 各要素: {"relevance": 1-5, "summary_ja": str, "reason": str, "tags": [str]}
- relevance: 1=無関係, 2=弱い関連, 3=中程度, 4=強い関連, 5=必読
- summary_ja: 日本語で3行以内の要約
- reason: 日本語で1文、読むべき理由（無関係なら読まなくてよい理由）
- tags: 最大4個の日本語タグ（例: 「新手法」「ベンチマーク」「応用」「理論」）
"""

_USER_TEMPLATE = """\
## あなたの研究プロファイル
{profile}

## 評価対象の論文（{count}件）
{papers_block}

上記の論文を、入力順と同じ順序のJSON配列で評価してください。
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


# ---- Lineage relation classification (used by scripts/build_lineage.py) ----

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
_CLASSIFY_ABSTRACT_TRIM = 600

# Heuristic template rationales — the system prompt forbids the LLM from
# outputting these (it was happily regurgitating them as direct
# translations of the enum definitions, see #131 production trace). Kept
# as a frozenset so ``RelationClassification.from_dict`` can also second-
# line-defend by rejecting any LLM output that lands on a template
# byte-for-byte. When rejected, ``_apply_llm_classification`` falls back
# to the heuristic — same user-visible rationale, but no false claim that
# the LLM added value.
_GENERIC_TEMPLATE_RATIONALES = frozenset({
    "論文 B は論文 A の手法を異なる領域・タスク・スケールに拡張している。",
    "論文 B は論文 A の研究ラインを継承し自然に発展させている。",
    "論文 B は論文 A をベースライン比較にのみ用いている。",
    "論文 B は論文 A と根本的に異なるアプローチを提案している。",
    "論文 B は論文 A の手法を置き換える改良版として提案されている。",
    "論文 B は論文 A の構成要素を分析・ablation している。",
})


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
# Token budget note: kept under ~250 tokens because Groq's free tier
# caps at 6,000 TPM. A larger prompt × 25 RPM (rate limiter default)
# would burn through the TPM budget and 429-throttle the back half of
# each burst, which was the regression observed in the #131 first-cut
# rewrite (PR #132's first deploy got timed out at 8 min).
CLASSIFY_SYSTEM_PROMPT = """\
Compare two AI/ML papers (A older, B newer). Output ONLY JSON:
{"relation":"<one>","confidence":<0.0-1.0>,"rationale":"<one Japanese sentence>"}

relation values: supersedes / successor / extends / ablation / baseline_only / contrasts / unrelated

rationale rules — read carefully, this is what gets wrong most often:
- 30-200 chars, one Japanese sentence
- MUST mention a concrete concept from B's title or abstract (a method name, dataset, metric, or architectural choice). The reader should know which two papers are compared from the rationale alone.
- NEVER output these heuristic templates (emitting them wastes an LLM call):
  - "論文 B は論文 A の手法を異なる領域・タスク・スケールに拡張している"
  - "論文 B は論文 A の研究ラインを継承し自然に発展させている"
  - "論文 B は論文 A をベースライン比較にのみ用いている"
  - "論文 B は論文 A と根本的に異なるアプローチを提案している"

Good example: "B のグラフ畳み込み層は、A のスペクトル法を空間領域に再定式化し計算量を O(E) に落としている。"
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
