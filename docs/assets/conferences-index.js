// Renders the conference list on the root page (docs/index.html) from
// conferences.json, and fills the hero "issue dateline" with the live
// aggregate scale (conference count / total papers / newest data date).
// Externalised in 2026-05 from a same-page inline <script> so the strict
// `script-src 'self'` CSP applied to the GH Pages viewer doesn't have to
// ship 'unsafe-inline'. No build step — the .html ref points here directly.

// conferences.json is our own committed artefact, but we still validate the
// two fields that flow into markup (the slug, which becomes an href, and the
// date, rendered as text) before injecting them — defence-in-depth against a
// compromised/misgenerated JSON, since `script-src 'self'` does not block a
// `href="javascript:…"` navigation. Anything that fails the shape check is
// skipped, not rendered.
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const safeDate = (d) => (typeof d === "string" && DATE_RE.test(d) ? d : "");

// The dateline numerals are wrapped in <b> (styled serif via .hero__stat b)
// so the hero borrows the catalog's big-numeral "data voice". The fallback
// string already in the markup is the no-JS / pre-fetch state and stays
// truthful regardless of counts, so we only upgrade it once we have data.
function renderDateline(conferences) {
  const el = document.getElementById("hero-dateline");
  if (!el || !conferences.length) return;

  const confCount = conferences.length;
  const totalPapers = conferences.reduce((sum, c) => sum + (c.papers || 0), 0);
  // YYYY-MM-DD sorts lexically, so the max valid date is the newest.
  const latest = conferences.map((c) => safeDate(c.generated)).filter(Boolean).sort().pop();

  const sep = `<span class="hero__dateline-sep" aria-hidden="true">·</span>`;
  const parts = [
    `<span class="hero__stat"><b>${confCount}</b>学会</span>`,
    `<span class="hero__stat"><b>${totalPapers.toLocaleString("en-US")}</b>論文</span>`,
  ];
  if (latest) {
    parts.push(`<span class="hero__stat hero__stat--muted"><span class="hero__nowrap">最終更新 ${latest}</span></span>`);
  }
  el.innerHTML = parts.join(sep);
}

function renderConferenceList(conferences) {
  const list = document.getElementById("conf-list");
  if (!list) return;
  if (!conferences.length) {
    list.innerHTML = `<li class="conf-empty">まだ学会データがありません。<a href="themes/">テーマ家系図</a>から始められます。</li>`;
    return;
  }
  const sep = `<span class="conf__meta-sep" aria-hidden="true">·</span>`;
  list.innerHTML = conferences
    .filter((c) => SLUG_RE.test(c.name))
    .map((c) => {
      const oral = c.types.Oral || 0;
      const fresh = safeDate(c.generated);
      const tags = c.top_tags.map(([t, n]) =>
        `<span class="conf__tag">${t} <span class="conf__tag-count">${n}</span></span>`
      ).join("");
      // Meta line carries the semantic gold Oral chip + the data freshness;
      // the raw paper total is already the big numeral on the right, so it
      // isn't repeated here. Each piece is optional and self-omits.
      const meta = [
        oral ? `<span class="conf__oral">${oral} Oral</span>` : "",
        fresh ? `<span class="conf__fresh">最終更新 ${fresh}</span>` : "",
      ].filter(Boolean).join(sep);
      return `
        <li class="conf">
          <div>
            <h3 class="conf__name"><a href="${c.name}/">${c.name.toUpperCase().replace(/-/g, " ")}</a></h3>
            <p class="conf__meta">${meta}</p>
            <div class="conf__tags">${tags}</div>
          </div>
          <div>
            <div class="conf__count">${c.papers}</div>
            <span class="conf__count-label">papers</span>
          </div>
        </li>`;
    }).join("");
}

fetch("conferences.json")
  .then((r) => r.json())
  .then((conferences) => {
    renderDateline(conferences);
    renderConferenceList(conferences);
  })
  .catch(() => {
    const list = document.getElementById("conf-list");
    if (list) {
      list.innerHTML = `<li class="conf-empty">学会一覧を読み込めませんでした。<a href="themes/">テーマ家系図</a>から始めることもできます。</li>`;
    }
  });
