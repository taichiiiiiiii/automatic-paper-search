"""Element-level validation for fetched payloads.

Lives in ``utils`` rather than beside the completeness ledger because
``utils.github`` needs it too and deliberately imports nothing from the
higher layers.
"""

from __future__ import annotations

import re


def first_unusable(items, usable, *, allow_none: bool = False):
    """The first element the consumer's own predicate cannot use.

    Returns ``(index, element)`` or ``None`` when every element passes.

    The defect this removes, found at eight sites in a single review: a
    loop that quietly skips elements it cannot interpret. Each skip
    reads as defensive on its own, and together they turn a broken page
    into a smaller, entirely plausible answer — an empty seed set, a
    dropped Oral, a paper with no references — which is then frozen
    into a cache that has no expiry. Validating the array's container
    was not enough; the elements are part of the answer.

    ``usable`` must be the predicate the CONSUMER applies, not a looser
    one. Checking that an id is a non-empty string while the consumer
    requires ``^W[0-9]+$`` moves the silent drop one level down instead
    of removing it. A predicate that raises counts as a failed check,
    so the caller does not have to pre-guard types.

    Scope, deliberately: only what the service structurally guarantees
    (the element's type, and the identifier it always echoes). Fields
    that may genuinely be absent from a well-formed record — a Work
    with no title — stay ordinary data and are still filtered by the
    caller. Rejecting a whole page over those would invent an outage.

    ``allow_none`` is for the one array where a hole is the answer: S2's
    ``/paper/batch`` returns ``null`` in place for an id it does not
    know.
    """
    for index, item in enumerate(items):
        if item is None and allow_none:
            continue
        try:
            if usable(item):
                continue
        except Exception:  # a predicate that throws is a failed check
            pass
        return index, item
    return None


# ---------------------------------------------------------------------
# Shared identifier predicates.
#
# Each of these is the SINGLE definition of "usable" for one kind of id,
# called both by the consumer that needs the value and by the
# ``first_unusable`` check that guards the page it came from. Writing
# the predicate twice — once in the consumer, once as a lambda at the
# validation site — is what produced four separate escapes of the same
# bug: the guard accepted a non-empty string while the consumer wanted
# ``^W[0-9]+$``, so the silent drop moved one level down instead of
# going away. Two definitions drift; one cannot.
# ---------------------------------------------------------------------

_OPENALEX_SHORT_ID_RE = re.compile(r"^W[0-9]+$")
_GH_SLUG_SEGMENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


_OPENALEX_ID_URL_RE = re.compile(
    r"^https?://(?:api\.)?openalex\.org/(?:works/)?(W[0-9]+)/?$"
)


def openalex_short_id(value: object) -> str | None:
    """``https://openalex.org/W123`` or ``W123`` -> ``"W123"``, else None.

    OpenAlex writes every Work id in one of those two shapes, so a value
    that does not reduce to ``W<digits>`` is a broken payload rather
    than a Work we happen not to want.

    The host is part of the identity. Taking the last path segment of
    anything accepted ``https://evil.example/W123`` as ``W123`` — which
    matters more now that this one function backs payload admission,
    catalog aliases and the unarXive lookup, so a spoofed URL would
    propagate as provenance everywhere at once.
    """
    if not isinstance(value, str) or not value:
        return None
    candidate = value.strip()
    if _OPENALEX_SHORT_ID_RE.fullmatch(candidate):
        return candidate
    match = _OPENALEX_ID_URL_RE.fullmatch(candidate)
    return match.group(1) if match else None


def _optional_text(value: object) -> bool:
    """Absent or null (the field was not provided) or an actual string.

    Anything else is a broken record rather than a missing one: the
    consumers splice these straight into titles, regex matches and
    node fields.
    """
    return value is None or isinstance(value, str)


def _optional_mapping(value: object) -> bool:
    """Absent or null, or an actual mapping."""
    return value is None or isinstance(value, dict)


def _optional_mapping_list(
    value: object,
    *,
    inner_key: str | None = None,
    name_key: str | None = None,
) -> bool:
    """Absent/null, or a list whose elements are mappings.

    ``inner_key`` additionally requires that nested value to be
    absent/null/mapping — ``authorships[i].author`` and the like, which
    consumers call ``.get()`` on without a guard.

    ``name_key`` requires the display string on the element (or on the
    ``inner_key`` object when one is given) to be absent/null/string.
    Its absence is fine — an anonymous authorship is real — but a
    non-string is a broken record, and the consumers copy that value
    straight into the artifact's ``authors`` array, so it leaks past
    the shape check into published data instead of raising.
    """
    if value is None:
        return True
    if not isinstance(value, list):
        return False
    for item in value:
        if not isinstance(item, dict):
            return False
        target = item
        if inner_key is not None:
            nested = item.get(inner_key)
            if nested is not None and not isinstance(nested, dict):
                return False
            target = nested if isinstance(nested, dict) else {}
        if name_key is not None and not _optional_text(target.get(name_key)):
            return False
    return True


def _optional_number(value: object) -> bool:
    """Absent/null, or a real number. ``bool`` is not one.

    Consumers divide, compare and sum these, so a string here is a
    ``TypeError`` or a ``ValueError``, not a paper we simply cannot
    rank.
    """
    if value is None:
        return True
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _optional_int(value: object) -> bool:
    if value is None:
        return True
    return isinstance(value, int) and not isinstance(value, bool)


def _optional_text_fields(mapping: object, keys: tuple[str, ...]) -> bool:
    """Every named key on ``mapping`` is absent/null/string."""
    if not isinstance(mapping, dict):
        return True
    return all(_optional_text(mapping.get(key)) for key in keys)


def s2_cached_neighbour_ok(paper: object) -> bool:
    """One element of a FLATTENED relation cache file.

    The cache stores the inner paper with the envelope's fields lifted
    onto it, so it must clear both bars: ``select_top`` passes the
    entry to ``to_node``, which indexes ``paper["title"]`` directly,
    and the lifted ``_is_influential`` / ``_intents`` / ``_contexts``
    steer relation classification.
    """
    if s2_paper_shape(paper, require_title=True) is None:
        return False
    assert isinstance(paper, dict)
    influential = paper.get("_is_influential")
    if influential is not None and not isinstance(influential, bool):
        return False
    for key in ("_intents", "_contexts"):
        value = paper.get(key)
        if value is None:
            continue
        if not isinstance(value, list) or not all(isinstance(i, str) for i in value):
            return False
    return True


def s2_relation_entry_ok(entry: object, inner_key: str) -> bool:
    """One element of an S2 ``references``/``citations`` envelope.

    The entry-level fields need checking as much as the nested paper
    does, and they fail more quietly: ``bool(entry["isInfluential"])``
    turns the string ``"false"`` into True, and
    ``[str(i) for i in intents]`` renders a dict as ``"{'a': 1}"`` and
    writes it to a cache that never expires. Neither raises; both
    corrupt the relation.
    """
    if not isinstance(entry, dict):
        return False
    if s2_paper_shape(entry.get(inner_key)) is None:
        return False
    influential = entry.get("isInfluential")
    if influential is not None and not isinstance(influential, bool):
        return False
    intents = entry.get("intents")
    if intents is None:
        return True
    return isinstance(intents, list) and all(isinstance(i, str) for i in intents)


def s2_paper_shape(payload: object, *, require_title: bool = False) -> str | None:
    """The paperId of an S2 paper whose consumed fields are readable.

    Validating the id alone left the class half-closed: ``to_node``
    does ``a.get("name")`` over ``authors`` and uses ``title`` /
    ``venue`` / ``abstract`` as strings, so ``{"paperId": "P1",
    "authors": [1]}`` cleared the element guard, was cached, and then
    raised ``AttributeError`` through the fail-safe boundary.

    Absent and null stay legitimate throughout — a paper with no
    recorded venue is data, not a broken response.
    """
    paper_id = s2_paper_id(payload)
    if paper_id is None:
        return None
    assert isinstance(payload, dict)
    if not _optional_mapping_list(payload.get("authors"), name_key="name"):
        return None
    for key in ("title", "venue", "abstract"):
        if not _optional_text(payload.get(key)):
            return None
    # `to_node` does `external.get(...)` and copies the result straight
    # into the node's `arxiv_id` / `doi`, so the VALUES matter as much
    # as the container — the same check the OpenAlex `ids` block gets.
    if not _optional_mapping(payload.get("externalIds")):
        return None
    if not _optional_text_fields(
        payload.get("externalIds"), ("ArXiv", "arxiv", "DOI", "doi")
    ):
        return None
    if not _optional_number(payload.get("citationCount")):
        return None
    if not _optional_int(payload.get("year")):
        return None
    if require_title:
        # A focus paper is different from a neighbour: `to_node` indexes
        # `paper["title"]` directly, and the artifact is *about* this
        # paper. An untitled neighbour is droppable data; an untitled
        # focus is a response we cannot build from.
        title = payload.get("title")
        if not isinstance(title, str) or not title.strip():
            return None
    return paper_id


def openalex_work_shape(work: object) -> str | None:
    """The Work's short id when its alias-bearing blocks are readable.

    A missing alias is ordinary data — plenty of Works carry no DOI and
    no arXiv id. A block of the WRONG TYPE is not: consumers do
    ``work.get("ids") or {}`` and then ``.get()`` on the result, so
    ``"ids": []`` reaches an ``AttributeError`` that crosses the
    fail-safe boundary and aborts the whole build, while a non-mapping
    block that happens not to crash silently reduces the Work to zero
    aliases — which for an Oral is indistinguishable from "did not
    match".
    """
    short = openalex_short_id(work.get("id") if isinstance(work, dict) else None)
    if short is None:
        return None
    for key in ("ids", "primary_location"):
        value = work.get(key)
        if value is not None and not isinstance(value, dict):
            return None
    if not _optional_mapping_list(work.get("locations")):
        return None
    # `authorships[i].author` is reached with `.get()` by both builders,
    # so a string there is an AttributeError through the fail-safe
    # boundary, not a Work we merely cannot credit.
    if not _optional_mapping_list(
        work.get("authorships"), inner_key="author", name_key="display_name"
    ):
        return None
    primary = work.get("primary_location")
    if isinstance(primary, dict) and not _optional_mapping(primary.get("source")):
        return None
    for key in ("title", "display_name", "doi"):
        if not _optional_text(work.get(key)):
            return None
    # Scalars the consumers use directly: `int(cited_by_count or 0)`
    # raises on a string, and the year feeds comparisons.
    if not _optional_number(work.get("cited_by_count")):
        return None
    if not _optional_int(work.get("publication_year")):
        return None
    # `venue` is read straight off the nested source and then
    # `.strip()`ed downstream.
    if isinstance(primary, dict) and not _optional_text_fields(
        primary.get("source"), ("display_name",)
    ):
        return None
    # The alias values `_work_aliases` reads. A non-string here is
    # dropped in silence, and when it was the only alias the Oral
    # leaves the focus set as a plain "no match".
    if not _optional_text_fields(
        work.get("ids"),
        ("openalex", "doi", "arxiv", "arxiv_id", "openreview", "openreview_id", "mag", "pmid"),
    ):
        return None
    location_urls = ("landing_page_url", "pdf_url")
    if not _optional_text_fields(primary, location_urls):
        return None
    locations = work.get("locations")
    if isinstance(locations, list) and not all(
        _optional_text_fields(loc, location_urls) for loc in locations
    ):
        return None
    return short


def s2_paper_id(payload: object) -> str | None:
    """The usable ``paperId`` of a Semantic Scholar paper object.

    The endpoints echo the id they resolved, so an object without a
    non-empty string one is a broken response. A *truthy* non-string
    (``123``, ``True``) is worse than a missing key: it survives a
    ``bool(...)`` check and is then carried into the artifact as a dict
    key and a graph node id.
    """
    if not isinstance(payload, dict):
        return None
    paper_id = payload.get("paperId")
    if not isinstance(paper_id, str) or not paper_id.strip():
        return None
    return paper_id


def gh_repo_slug(full_name: object) -> tuple[str, str] | None:
    """``"owner/repo"`` -> ``("owner", "repo")`` when both halves are
    valid slugs, else None.

    The slug shape is a security boundary (SSRF / path traversal), so
    the same function backs the validation of a search page and the
    consumption of each item: a name the loop would skip must not be
    counted as a well-formed "no match".
    """
    if not isinstance(full_name, str) or "/" not in full_name:
        return None
    owner, _, name = full_name.partition("/")
    # fullmatch, not match: `$` also matches before a trailing newline,
    # so "owner/repo\n" passed a check that guards URL construction.
    if not _GH_SLUG_SEGMENT_RE.fullmatch(owner) or not _GH_SLUG_SEGMENT_RE.fullmatch(name):
        return None
    return owner, name
