"""Stage 3 (Embedding similarity) tests with a fake encoder."""

from __future__ import annotations

from datetime import date

import numpy as np

from paperpilot.models import Paper
from paperpilot.pipeline.stage_embedding import AbstractEncoder, embed_and_rank


class FakeEncoder(AbstractEncoder):
    """Deterministic encoder that maps known tokens to orthogonal vectors."""

    def __init__(self) -> None:
        self.dim = 3
        self._map = {
            "rag": np.array([1.0, 0.0, 0.0]),
            "llm": np.array([0.0, 1.0, 0.0]),
            "vision": np.array([0.0, 0.0, 1.0]),
        }

    def encode(self, texts: list[str]) -> np.ndarray:
        vecs = []
        for t in texts:
            v = np.zeros(self.dim)
            for token, emb in self._map.items():
                if token in t.lower():
                    v = v + emb
            norm = np.linalg.norm(v)
            vecs.append(v / norm if norm > 0 else v)
        return np.array(vecs)


def _paper(title: str, total: float = 0.0, suffix: str = "x") -> Paper:
    return Paper(
        title=title,
        authors=["A"],
        abstract="abs",
        url=f"http://x/{suffix}",
        published_date=date.today(),
        source="arxiv",
        arxiv_id=f"2604.{suffix}",
        total_score=total,
    )


def test_embed_and_rank_reorders_by_similarity():
    papers = [
        _paper("Vision Transformer", total=10, suffix="1"),
        _paper("RAG for LLM", total=10, suffix="2"),
        _paper("LLM internals", total=10, suffix="3"),
    ]
    encoder = FakeEncoder()
    # "rag llm" gives non-zero sim to paper 2 (1.0), paper 3 (~0.71), paper 1 (0)
    profile = "rag llm"
    out = embed_and_rank(
        papers,
        encoder=encoder,
        profile_text=profile,
        top_n=3,
        weight=2.5,
    )
    assert [p.arxiv_id for p in out] == ["2604.2", "2604.3", "2604.1"]
    # similarity field populated, score added to total_score
    assert all(p.embedding_similarity is not None for p in out)
    assert out[0].total_score > out[2].total_score


def test_embed_and_rank_skips_when_profile_empty():
    """With no profile, Stage 3 passes through unchanged (fallback mode A)."""
    papers = [_paper("A", total=5, suffix="1"), _paper("B", total=3, suffix="2")]
    encoder = FakeEncoder()
    out = embed_and_rank(papers, encoder=encoder, profile_text="", top_n=5, weight=2.5)
    # Unchanged (sorted by existing total_score)
    assert out[0].total_score == 5.0
    assert out[0].embedding_similarity is None


def test_embed_and_rank_empty_input():
    encoder = FakeEncoder()
    assert embed_and_rank([], encoder=encoder, profile_text="rag", top_n=5, weight=2.5) == []


def test_embed_and_rank_top_n_truncation():
    papers = [_paper(f"P{i}", total=float(i), suffix=str(i)) for i in range(5)]
    encoder = FakeEncoder()
    out = embed_and_rank(papers, encoder=encoder, profile_text="rag", top_n=2, weight=2.5)
    assert len(out) == 2


def test_encoder_failure_fallsthrough():
    """If encoder raises, Stage 3 keeps papers unchanged (Fail-Safe)."""
    papers = [_paper("A", total=5, suffix="1"), _paper("B", total=3, suffix="2")]

    class BrokenEncoder(AbstractEncoder):
        def encode(self, texts: list[str]) -> np.ndarray:
            raise RuntimeError("model load failed")

    out = embed_and_rank(
        papers,
        encoder=BrokenEncoder(),
        profile_text="rag",
        top_n=5,
        weight=2.5,
    )
    # Preserves input order with embeddings untouched
    assert len(out) == 2
    assert all(p.embedding_similarity is None for p in out)


def test_normalization_bounds_similarity_to_0_100():
    """embedding_similarity is normalized to [0, 100] (cos sim shifted from [-1,1])."""
    papers = [_paper("rag", total=0, suffix="1")]
    encoder = FakeEncoder()
    out = embed_and_rank(papers, encoder=encoder, profile_text="rag", top_n=1, weight=1.0)
    # Cosine(rag, rag) = 1.0 -> normalized to 100.0
    assert out[0].embedding_similarity == 100.0
