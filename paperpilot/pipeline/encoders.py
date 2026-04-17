"""Optional embedding encoders for Stage 3.

The default `MiniLMEncoder` uses sentence-transformers with
`all-MiniLM-L6-v2` (~80MB). It's a soft dependency — import only
when Stage 3 is activated.

Users who want a different model (SPECTER2, BGE, Cohere, etc.) can
subclass `AbstractEncoder` in `stage_embedding.py` and pass the
instance to the runner.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from ..utils.logger import get_logger
from .stage_embedding import AbstractEncoder

if TYPE_CHECKING:
    import numpy as np

logger = get_logger(__name__)

DEFAULT_MODEL = "sentence-transformers/all-MiniLM-L6-v2"


class MiniLMEncoder(AbstractEncoder):
    """Lightweight sentence-transformers encoder (~80MB CPU)."""

    def __init__(self, model_name: str = DEFAULT_MODEL) -> None:
        self.model_name = model_name
        self._model = None  # lazy-load on first encode()

    def encode(self, texts: list[str]) -> np.ndarray:
        import numpy as np

        if not texts:
            return np.zeros((0, 384))  # MiniLM-L6 is 384-dim

        if self._model is None:
            try:
                from sentence_transformers import SentenceTransformer
            except ImportError as e:
                raise ImportError(
                    "MiniLMEncoder requires the `sentence-transformers` package. "
                    "Install with: pip install 'paperpilot[embedding]' "
                    "or `pip install sentence-transformers`."
                ) from e
            logger.info("encoders: loading %s (first call may take ~15s)", self.model_name)
            self._model = SentenceTransformer(self.model_name)

        assert self._model is not None  # for mypy
        result = self._model.encode(
            texts,
            normalize_embeddings=True,
            show_progress_bar=False,
            convert_to_numpy=True,
        )
        return np.asarray(result)
