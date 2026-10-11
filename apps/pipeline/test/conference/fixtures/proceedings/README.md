# Recorded official-source excerpts (R3-1, fetched 2026-10-11)

Trimmed copies of live responses, used by `../../proceedings/*.test.ts`,
`../../openreview/sourceBlocked.test.ts` and `../../watch/{groups,sourceBlocked}.test.ts`.
Each was fetched once with a `PaperPilot/1.0` User-Agent; none of the hosts
publishes a robots.txt restriction for these paths (PMLR, papers.nips.cc,
CVF Open Access and aclanthology.org return 404 for `/robots.txt`;
`raw.githubusercontent.com` serves the ACL Anthology XML).

| File | Source | Trimmed to |
|---|---|---|
| `openreview_notes_403_challenge.json` | `GET https://api2.openreview.net/notes?content.venueid=ICML.cc/2026/Conference&limit=1` | verbatim 403 body (`ChallengeRequiredError`) |
| `openreview_groups_venues_excerpt.json` | `GET https://api2.openreview.net/groups?id=venues` | `members` filtered to ICML/NeurIPS/ICLR/ACL/EMNLP/COLM/CVPR/ICCV/ECCV 2025–2027 + 2 unrelated ids (live list: 4,768) |
| `openreview_group_{icml,neurips}_2026_excerpt.json` | `GET …/groups?id=<venue>/2026/Conference` | `content` fields `title, subtitle, start_date, location, website, accept_decision_options, decision_heading_map` |
| `pmlr_v306_volume_excerpt.html` | `https://proceedings.mlr.press/v306/` (6,552 papers) | page head (scripts removed) + 3 paper blocks |
| `pmlr_v306_bibliography_excerpt.bib` | `https://proceedings.mlr.press/v306/assets/bib/bibliography.bib` | `@Proceedings` + the same 3 `@InProceedings` |
| `acl_2026_anthology_excerpt.xml` | `https://raw.githubusercontent.com/acl-org/acl-anthology/master/data/xml/2026.acl.xml` | volumes `long` (2 papers), `short` (1), `demo` (1) |
| `cvf_cvpr2026_listing_excerpt.html` | `https://openaccess.thecvf.com/CVPR2026?day=all` | first 3 `<dt class="ptitle">` entries |
| `neurips_2024_listing_excerpt.html` | `https://papers.nips.cc/paper_files/paper/2024` | 2 main-track + 1 D&B entries |
| `neurips_2025_listing_excerpt.html` | `https://papers.nips.cc/paper_files/paper/2025` | 3 entries (the live page had only the 64-paper Creative AI track) |

Licences: PMLR articles are CC BY 4.0 (PMLR publication agreement); ACL
Anthology material from 2016 on is CC BY 4.0; CVF and NeurIPS grant no
public licence, so only titles/authors/links are used from them (design 51).
