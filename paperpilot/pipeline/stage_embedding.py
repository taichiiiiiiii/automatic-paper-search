"""Stage 3: Embedding similarity against a research profile.

Design doc §4.4 recommends SPECTER2, but SPECTER2 pulls torch +
transformers + ~1GB of weights. We instead ship with a pluggable
`AbstractEncoder` so users can:

  - use the lightweight default (`MiniLMEncoder`, ~80MB)
  - swap in SPECTER2 or any other model by providing a subclass
  - skip Stage 3 entirely when no encoder / profile is available

Normalization (Table 12): cos-sim in [-1, 1] -> shifted/scaled to
[0, 100] via `(sim + 1) / 2 * 100`. This preserves the design's
"0..100 per signal" invariant.

Fallback per §4.4:
  - Mode A (skipped): profile_text empty -> pass through unchanged.
  - Mode B (init-profile): user runs a CLI to bootstrap a profile from
    seed arxiv IDs. Not yet implemented.
  - Mode C (keywords): caller passes search keywords joined as the
    profile. Handled transparently — just pass the string.
"""

from __future__ import annotations

from abc import ABC, abstractmethod

import numpy as np

from ..models import Paper
from ..utils.logger import get_logger

logger = get_logger(__name__)


class AbstractEncoder(ABC):
    """Contract every embedding backend must satisfy."""

    @abstractmethod
    def encode(self, texts: list[str]) -> np.ndarray:
        """Return a (len(texts), dim) float array. Rows may be L2-normalized."""


def embed_and_rank(
    papers: list[Paper],
    encoder: AbstractEncoder,
    profile_text: str,
    top_n: int,
    weight: float = 2.5,
) -> list[Paper]:
    """Compute cos-sim between each paper and the profile, add to total_score.

    Fail-Safe: if the encoder raises, papers flow through unchanged with
    embedding_similarity=None so Stage 4 still has something to rank.
    """
    if not papers:
        return []

    # Mode A: no profile -> skip Stage 3 entirely
    if not profile_text.strip():
        logger.info("stage3: profile empty, skipping embedding step")
        return papers[:top_n] if top_n > 0 else papers

    try:
        paper_texts = [_paper_text(p) for p in papers]
        vectors = encoder.encode(paper_texts)
        profile_vec = encoder.encode([profile_text])[0]
    except Exception as e:
        logger.warning("stage3: encoder failed (%s); skipping embedding", e)
        return papers[:top_n] if top_n > 0 else papers

    # Cosine similarity (assumes inputs are normalized; if not, normalize here).
    sims = _cosine_similarity(vectors, profile_vec)
    # Normalize to [0, 100]: cos in [-1, 1] -> shifted and scaled.
    sim_0_100 = np.clip((sims + 1.0) / 2.0 * 100.0, 0.0, 100.0)

    for paper, score in zip(papers, sim_0_100, strict=False):
        paper.embedding_similarity = float(score)
        paper.total_score = paper.total_score + float(score) * weight

    papers.sort(key=lambda p: p.total_score, reverse=True)
    out = papers[:top_n] if top_n > 0 else papers
    logger.info("stage3: kept top %d papers after embedding rerank", len(out))
    return out


def _paper_text(p: Paper) -> str:
    """Text used to embed a paper. Title is most informative; add abstract tail."""
    abstract_snippet = (p.abstract or "")[:400]
    return f"{p.title}. {abstract_snippet}"


def _cosine_similarity(vectors: np.ndarray, query: np.ndarray) -> np.ndarray:
    """Row-wise cosine similarity of `vectors` against `query`."""
    v_norm = np.linalg.norm(vectors, axis=1)
    q_norm = np.linalg.norm(query)
    denom = v_norm * q_norm
    denom = np.where(denom == 0, 1.0, denom)  # avoid div-by-zero
    return np.asarray((vectors @ query) / denom)
