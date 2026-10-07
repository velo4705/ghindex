/**
 * Category taxonomy.
 *
 * Why this exists: raw GitHub topics are free-form, so the corpus carries 11,677
 * distinct tags and 72% of them appear exactly ONCE. The top tags are
 * technologies (react 854, javascript 822, html 628, css 625), which answers
 * "what was this built with" when a visitor wants "what kind of thing is
 * this". Browsing by raw topic is therefore close to useless.
 *
 * Fix: a small CLOSED set of purpose-based categories, derived from topics so a
 * result classifies itself with no manual step.
 *
 * Rules that matter:
 *  - Categories are for BROWSING and FACETS. Raw topics are retained for free
 *    text search, so the taxonomy never degrades the search that already works.
 *  - Technology tags must NOT map to a "category" on their own. A site tagged
 *    only react/javascript/css/css3/html5/html-css is "Uncategorized", because
 *    we genuinely do not know what it is. Inventing a category would be worse
 *    than admitting ignorance.
 *  - Matching is longest-suffix / whole-token based, so "portfolio-website"
 *    hits "portfolio" and "reactjs" does not accidentally hit "react".
 *
 * This lives in the site directory as plain JavaScript, not in src/classify as
 * TypeScript, because it now runs in the browser. There is no longer a publish
 * step to bake categories into a generated index, so the only consumer of this
 * logic is the page, and a copy kept alongside the offline pipeline would drift
 * from the one actually shipping. src/classify/test.ts imports this file.
 */

export const CATEGORIES = [
  "portfolio",
  "games",
  "docs",
  "blog",
  "dashboards",
  "tools",
  "learning",
  "showcase",
  "libraries",
];

export const CATEGORY_LABELS = {
  portfolio: "Portfolio & CV",
  games: "Games",
  docs: "Docs & Wiki",
  blog: "Blog",
  dashboards: "Dashboards & Data",
  tools: "Tools & Utilities",
  learning: "Learning & Reference",
  showcase: "Showcase & Data Viz",
  libraries: "Libraries & Frameworks",
};

/**
 * topic -> category. Ordered longest-key-first at match time, so a specific
 * topic ("portfolio-template") wins over a generic one ("website").
 * Technology-only tags are deliberately absent.
 */
const TOPIC_MAP = {
  // portfolio & CV
  portfolio: "portfolio",
  "personal-website": "portfolio",
  "personal-site": "portfolio",
  "developer-portfolio": "portfolio",
  "web-portfolio": "portfolio",
  "portfolio-site": "portfolio",
  "portfolio-page": "portfolio",
  resume: "portfolio",
  "resume-website": "portfolio",
  "resume-template": "portfolio",
  "resume-builder": "portfolio",
  "cv-builder": "portfolio",
  "curriculum-vitae": "portfolio",
  "cv-maker": "portfolio",
  "personal-homepage": "portfolio",
  profile: "portfolio",
  "developer-profile": "portfolio",
  "online-resume": "portfolio",
  "personal": "portfolio",

  // games
  game: "games",
  games: "games",
  "game-development": "games",
  "game-dev": "games",
  gamejam: "games",
  "game-jam": "games",
  "browser-game": "games",
  "html5-game": "games",
  "javascript-game": "games",
  "web-game": "games",
  roguelike: "games",
  platformer: "games",
  phaser: "games",
  godot: "games",
  unity: "games",
  "game-engine": "games",
  itch: "games",
  "rpg": "games",
  puzzle: "games",
  "three-js-game": "games",
  "canvas-game": "games",
  tetris: "games",
  chess: "games",

  // docs & wiki
  documentation: "docs",
  docs: "docs",
  wiki: "docs",
  "knowledge-base": "docs",
  "user-guide": "docs",
  "api-docs": "docs",
  "api-documentation": "docs",
  mkdocs: "docs",
  "docusaurus": "docs",
  "gitbook": "docs",
  "cheatsheet": "docs",
  cheatsheets: "docs",
  reference: "docs",
  handbook: "docs",
  manual: "docs",
  tutorial: "docs",
  tutorials: "docs",
  "how-to": "docs",
  "getting-started": "docs",
  faq: "docs",

  // blog
  blog: "blog",
  blogging: "blog",
  "static-site": "blog",
  "static-site-generator": "blog",
  "personal-blog": "blog",
  "tech-blog": "blog",
  articles: "blog",
  posts: "blog",
  writing: "blog",
  jekyll: "blog",
  hugo: "blog",
  hexo: "blog",
  ghost: "blog",
  "blog-engine": "blog",
  "thoughts": "blog",
  notes: "blog",

  // dashboards & data
  dashboard: "dashboards",
  dashboards: "dashboards",
  "admin-dashboard": "dashboards",
  analytics: "dashboards",
  "data-visualization": "dashboards",
  dataviz: "dashboards",
  visualization: "dashboards",
  charts: "dashboards",
  "data-analysis": "dashboards",
  "data-science": "dashboards",
  monitoring: "dashboards",
  observability: "dashboards",
  metrics: "dashboards",
  grafana: "dashboards",
  "bi-dashboard": "dashboards",
  "data-dashboard": "dashboards",
  reporting: "dashboards",

  // tools & utilities
  cli: "tools",
  "command-line": "tools",
  "developer-tools": "tools",
  "dev-tools": "tools",
  toolbox: "tools",
  utility: "tools",
  utilities: "tools",
  converter: "tools",
  generator: "tools",
  "code-generator": "tools",
  "markdown-editor": "tools",
  editor: "tools",
  "regex": "tools",
  "json-formatter": "tools",
  formatter: "tools",
  linter: "tools",
  "code-review": "tools",
  "self-hosted": "tools",
  docker: "tools",
  kubernetes: "tools",
  automation: "tools",
  "web-scraper": "tools",
  scraper: "tools",
  downloader: "tools",
  "file-sharing": "tools",
  "online-tool": "tools",
  "productivity": "tools",
  "notes-app": "tools",
  "unit-converter": "tools",

  // learning & reference
  course: "learning",
  courses: "learning",
  education: "learning",
  "e-learning": "learning",
  learning: "learning",
  "study-notes": "learning",
  leetcode: "learning",
  algorithm: "learning",
  algorithms: "learning",
  "data-structures": "learning",
  "interview": "learning",
  "interview-prep": "learning",
  "competitive-programming": "learning",
  textbook: "learning",
  exercises: "learning",
  practice: "learning",
  "student": "learning",
  "hacktoberfest": "learning",
  roadmap: "learning",
  guides: "learning",
  "awesome": "learning",
  "awesome-list": "learning",
  "book": "learning",
  books: "learning",
  "slide-deck": "learning",
  slides: "learning",
  "lecture-notes": "learning",
  "note-taking": "learning",

  // showcase & data viz (creative/visual)
  showcase: "showcase",
  gallery: "showcase",
  "art-gallery": "showcase",
  "digital-art": "showcase",
  generative: "showcase",
  "creative-coding": "showcase",
  threejs: "showcase",
  "three-js": "showcase",
  webgl: "showcase",
  canvas: "showcase",
  animation: "showcase",
  "css-animation": "showcase",
  "design-showcase": "showcase",
  "project-showcase": "showcase",
  inspiration: "showcase",
  "code-art": "showcase",
  "shader": "showcase",

  // libraries & frameworks
  // Derived from corpus analysis: the single largest group of otherwise
  // uncategorized sites are library/framework/UI-kit docs, not apps.
  library: "libraries",
  libraries: "libraries",
  framework: "libraries",
  frameworks: "libraries",
  "ui-kit": "libraries",
  "component-library": "libraries",
  "design-system": "libraries",
  "design-systems": "libraries",
  "component-library-react": "libraries",
  components: "libraries",
  "reusable-components": "libraries",
  uikit: "libraries",
  "ui-components": "libraries",
  sdk: "libraries",
  "plugin-system": "libraries",
  boilerplate: "libraries",
  starter: "libraries",
  "starter-template": "libraries",
  "react-components": "libraries",
  "app-framework": "libraries",
  "mobile-development": "libraries",
  "cross-platform": "libraries",
  "state-management": "libraries",
  "reactive-programming": "libraries",
  "component-framework": "libraries",
  "web-framework": "libraries",
  "micro-framework": "libraries",
  "vanilla-js": "libraries",
  polyfill: "libraries",
  shim: "libraries",
  "javascript-library": "libraries",
  "npm-package": "libraries",
  package: "libraries",
  "build-tools": "libraries",
  bundler: "libraries",
  transpiler: "libraries",
  "dev-server": "libraries",
  "zero-configuration": "libraries",
  "video-editing": "libraries",
  "spreadsheet": "libraries",
  charting: "libraries",
  "charting-library": "libraries",
  "table-component": "libraries",
  "date-picker": "libraries",
  "form-library": "libraries",
  "animation-library": "libraries",
};

/** Normalize a topic for lookup: lowercase, collapse separators to "-". */
/**
 * "cv" is genuinely ambiguous on GitHub: 401 records carry it, but 134 of them
 * mean computer-vision (opencv, face-detection, deep-learning), not
 * curriculum-vitae. So bare "cv" is NOT sufficient evidence. It only counts as
 * portfolio when the record also carries a corroborating personal-site topic.
 * Getting this wrong silently mislabels 134 ML/AI projects as resumes.
 */
const CV_CORROBORATORS = new Set([
  "resume", "portfolio", "personal-website", "personal-site", "profile",
  "developer-portfolio", "cv-maker", "cv-template", "curriculum-vitae",
  "online-resume", "resume-website", "resume-template", "resume-builder",
]);

/** Topics that confirm "cv" means computer vision, not a resume. */
const CV_TECHNICAL = new Set([
  "opencv", "computer-vision", "deep-learning", "machine-learning",
  "face-detection", "image-processing", "neural-network", "pytorch",
  "tensorflow", "keras", "ml", "nlp", "llm", "ai", "object-detection",
  "segmentation", "opencv-python", "vision",
]);

function norm(topic) {
  return topic.toLowerCase().trim().replace(/[\s_]+/g, "-");
}

/**
 * Longest-key-first list, so "personal-website" is tested before "personal".
 */
const SORTED_KEYS = Object.keys(TOPIC_MAP).sort((a, b) => b.length - a.length);

/** Tokens that indicate a technology, used only to explain "Uncategorized". */
const TECH_TOKENS = new Set([
  "react", "reactjs", "vue", "vuejs", "angular", "svelte", "nextjs", "nuxt",
  "javascript", "typescript", "js", "html", "html5", "css", "css3", "scss",
  "sass", "less", "tailwind", "tailwindcss", "tailwind-css", "bootstrap",
  "bootstrap5", "nodejs", "node", "python", "django", "flask", "ruby", "rails",
  "php", "laravel", "java", "kotlin", "swift", "rust", "go", "golang", "c",
  "cpp", "csharp", "dotnet", "jquery", "webpack", "vite", "rollup", "babel",
  "redux", "vuex", "pwa", "android", "ios", "flutter", "react-native",
]);

/**
 * Classify one record. Multi-label on purpose: a portfolio blog is legitimately
 * both. Order follows CATEGORIES so facet ordering is stable.
 *
 * @param {string[]} topics raw GitHub topics for one repository
 * @returns {{categories: string[], evidence: Record<string, string[]>, techOnly: boolean}}
 */
export function classify(topics) {
  const normed = topics.map(norm).filter(Boolean);
  const found = new Map();
  let techOnly = true;

  // Pre-scan for the ambiguous "cv" decision.
  const hasCv = normed.includes("cv");
  const hasCvTech = normed.some((t) => CV_TECHNICAL.has(t));
  const hasCvCorroborator = normed.some((t) => CV_CORROBORATORS.has(t));
  const cvCountsAsPortfolio = hasCv && hasCvCorroborator && !hasCvTech;

  for (const t of normed) {
    if (t === "cv") {
      if (cvCountsAsPortfolio) {
        techOnly = false;
        if (!found.has("portfolio")) found.set("portfolio", []);
        found.get("portfolio").push("cv");
      } else {
        // Ambiguous or clearly computer-vision: not portfolio evidence.
        techOnly = false;
      }
      continue;
    }

    // Exact key match, then suffix match (portfolio-website -> portfolio).
    let hit;
    for (const key of SORTED_KEYS) {
      if (t === key || t.endsWith(`-${key}`) || t.startsWith(`${key}-`)) {
        hit = TOPIC_MAP[key];
        break;
      }
    }
    if (hit) {
      techOnly = false;
      if (!found.has(hit)) found.set(hit, []);
      const ev = found.get(hit);
      if (ev.length < 3) ev.push(t);
    } else if (!TECH_TOKENS.has(t)) {
      // An unknown non-technology topic: we still don't know the purpose.
      techOnly = false;
    }
  }

  const categories = CATEGORIES.filter((c) => found.has(c));
  const evidence = {};
  for (const [k, v] of found) evidence[k] = v;

  return { categories, evidence, techOnly };
}
