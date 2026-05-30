// Renders the conference list on the root page (docs/index.html) from
// conferences.json. Externalised in 2026-05 from a same-page inline
// <script> so the strict `script-src 'self'` CSP applied to the GH
// Pages viewer doesn't have to ship 'unsafe-inline'. No build step —
// the .html ref directly points at this file.
fetch("conferences.json")
  .then((r) => r.json())
  .then((conferences) => {
    const list = document.getElementById("conf-list");
    if (!conferences.length) {
      list.innerHTML = `<li class="conf-empty">No conferences yet.</li>`;
      return;
    }
    list.innerHTML = conferences.map((c) => {
      const oral = c.types.Oral || 0;
      const tags = c.top_tags.map(([t, n]) =>
        `<span class="conf__tag">${t} <span class="conf__tag-count">${n}</span></span>`
      ).join("");
      return `
        <li class="conf">
          <div>
            <h2 class="conf__name"><a href="${c.name}/">${c.name.toUpperCase().replace("-", " ")}</a></h2>
            <p class="conf__meta">${c.papers} papers · ${oral} oral · ${c.top_tags.length} top tags</p>
            <div class="conf__tags">${tags}</div>
          </div>
          <div>
            <div class="conf__count">${c.papers}</div>
            <span class="conf__count-label">papers</span>
          </div>
        </li>`;
    }).join("");
  })
  .catch(() => {
    document.getElementById("conf-list").innerHTML = `<li class="conf-empty">Failed to load conferences.json</li>`;
  });
