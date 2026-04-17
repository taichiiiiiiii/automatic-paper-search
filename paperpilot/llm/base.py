"""LLM provider abstraction (design doc §4.5).

Each provider implements evaluate_batch() to score a list of papers
against a research profile. The output follows a fixed schema
(PaperEvaluation) so callers are provider-agnostic.

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
