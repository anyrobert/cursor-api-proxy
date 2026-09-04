(() => {
  function slugify(s) {
    return String(s)
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "-");
  }

  async function loadStatus() {
    try {
      const r = await fetch("/api/status");
      if (!r.ok) throw new Error();
      const s = await r.json();
      const dot = document.getElementById("status-dot");
      if (!s.running) dot.classList.add("down");
    } catch {
      document.getElementById("status-dot").classList.add("down");
    }
  }

  function buildToc(container) {
    const headings = container.querySelectorAll("h2, h3");
    const toc = document.getElementById("toc");
    toc.innerHTML = "";
    headings.forEach((h) => {
      const id = h.id || slugify(h.textContent);
      h.id = id;
      const a = document.createElement("a");
      a.href = `#${id}`;
      a.textContent = h.textContent;
      a.className = `toc-${h.tagName.toLowerCase()}`;
      a.dataset.target = id;
      toc.appendChild(a);
    });

    const links = Array.from(toc.querySelectorAll("a"));
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            links.forEach((l) => {
              l.classList.toggle("active", l.dataset.target === e.target.id);
            });
          }
        }
      },
      { rootMargin: "-80px 0px -70% 0px" },
    );
    headings.forEach((h) => {
      observer.observe(h);
    });
  }

  function applyRenderer() {
    const renderer = new marked.Renderer();
    renderer.heading = (text, level) => {
      const slug = slugify(text);
      return `<h${level} id="${slug}">${text}</h${level}>`;
    };
    renderer.link = (href, title, text) => {
      const t = title ? ` title="${title}"` : "";
      const ext = /^https?:/.test(href);
      const tgt = ext ? ' target="_blank" rel="noopener"' : "";
      return `<a href="${href}"${t}${tgt}>${text}</a>`;
    };
    marked.setOptions({ gfm: true, breaks: false });
    marked.use({ renderer });
  }

  async function render() {
    applyRenderer();
    try {
      const r = await fetch("/api/wiki");
      const md = await r.text();
      const html = marked.parse(md);
      const wiki = document.getElementById("wiki");
      wiki.innerHTML = html;
      buildToc(wiki);
      if (location.hash) {
        const target = document.getElementById(location.hash.slice(1));
        if (target) target.scrollIntoView();
      }
    } catch (e) {
      document.getElementById("wiki").innerHTML =
        `<p>Failed to load wiki: ${e.message}</p>`;
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    loadStatus();
    render();
  });
})();
