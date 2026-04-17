"""Shared pytest fixtures."""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from paperpilot.models import Paper


@pytest.fixture
def sample_paper() -> Paper:
    return Paper(
        title="Retrieval-Augmented Generation for Language Models",
        authors=["Alice", "Bob"],
        abstract="We propose a retrieval augmented method for LLMs.",
        url="https://arxiv.org/abs/2604.01234",
        published_date=date.today() - timedelta(days=3),
        source="arxiv",
        arxiv_id="2604.01234",
        categories=["cs.CL", "cs.LG"],
        comment="Accepted at ICLR 2026",
    )


@pytest.fixture
def papers_batch() -> list[Paper]:
    today = date.today()
    base = [
        Paper(
            title=f"Paper {i}",
            authors=[f"Author {i}"],
            abstract=f"Abstract for paper {i}",
            url=f"https://arxiv.org/abs/2604.000{i}",
            published_date=today - timedelta(days=i),
            source="arxiv",
            arxiv_id=f"2604.000{i}",
            categories=["cs.LG"],
        )
        for i in range(1, 6)
    ]
    return base
