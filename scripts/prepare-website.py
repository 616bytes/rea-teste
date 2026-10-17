"""Prepare downloads, the sitemap and the sharing image for the static website."""

from io import BytesIO
from pathlib import Path
import json
from string import Template
import sys
import xml.etree.ElementTree as ET
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

from website import PageMetadata, SITE_ORIGIN, page_url


EXAMPLE_FILES = (
    "package.json",
    "main.js",
    "preload.js",
    "renderer.js",
    "csv.js",
    "index.html",
)


def prepare_sitemap(site):
    """Discover HTML routes automatically, excluding pages marked noindex."""
    namespace = "http://www.sitemaps.org/schemas/sitemap/0.9"
    ET.register_namespace("", namespace)
    sitemap = ET.Element(f"{{{namespace}}}urlset")
    for path in sorted(site.rglob("*.html")):
        policy = PageMetadata()
        policy.feed(path.read_text(encoding="utf-8"))
        if policy.noindex:
            continue
        entry = ET.SubElement(sitemap, f"{{{namespace}}}url")
        ET.SubElement(
            entry, f"{{{namespace}}}loc"
        ).text = page_url(site, path)
    ET.indent(sitemap, space="  ")
    ET.ElementTree(sitemap).write(
        site / "sitemap.xml", encoding="utf-8", xml_declaration=True
    )
    print(f"Prepared sitemap.xml ({len(sitemap)} indexable pages).")


def prepare_sharing_image(site):
    """Rasterize the maintained SVG for clients that need a PNG preview."""
    try:
        import cairosvg
    except (ImportError, OSError) as error:
        sys.exit(
            f"Cannot prepare sharing image: {error}. Install website/requirements.txt and native Cairo; see website/README.md."
        )
    source = site / "assets/social-card.svg"
    destination = site / "assets/social-card.png"
    cairosvg.svg2png(
        url=str(source), write_to=str(destination), output_width=1200, output_height=630
    )
    print("Prepared assets/social-card.png (1200 × 630).")


def prepare_project_identity(site, template):
    """Attach language-independent project facts to final indexable HTML only."""
    facts = json.loads(Template(template.read_text(encoding="utf-8")).substitute(origin=SITE_ORIGIN))
    payload = json.dumps(facts, ensure_ascii=False, indent=2).replace("<", "\\u003c").replace("&", "\\u0026")
    markup = f'<script id="rea-project-identity" type="application/ld+json">\n{payload}\n</script>\n'
    count = 0
    for path in sorted(site.rglob("*.html")):
        source = path.read_text(encoding="utf-8")
        metadata = PageMetadata()
        metadata.feed(source)
        if metadata.noindex:
            continue
        if source.count("</head>") != 1 or 'id="rea-project-identity"' in source:
            raise ValueError(f"{path}: project identity must be added once to a fresh page")
        path.write_text(source.replace("</head>", markup + "</head>"), encoding="utf-8")
        count += 1
    print(f"Prepared project structured data ({count} indexable pages).")


def prepare_agent_index(site):
    """Build a compact navigation index from indexable English page metadata."""
    lines = [
        "# REA — Reverse Engineer Anything",
        "",
        "> Local reverse-engineering CLI and MCP server for binaries, applications, and runtime behavior.",
        "",
        "This optional index links to maintained public pages. Follow each page for prerequisites, evidence, and limitations.",
        "",
        "## Project",
        "",
        "- [Source repository](https://github.com/morluto/rea): Code, releases, contribution rules, and technical documentation.",
        "- [npm package](https://www.npmjs.com/package/rea-agents): Published rea-agents package.",
        "",
        "## English documentation and examples",
        "",
    ]
    count = 0
    for path in sorted(site.rglob("*.html")):
        metadata = PageMetadata()
        metadata.feed(path.read_text(encoding="utf-8"))
        if metadata.noindex or metadata.lang != "en":
            continue
        if len(metadata.titles) != 1 or len(metadata.descriptions) != 1:
            raise ValueError(f"{path}: agent index needs one title and description")
        title = " ".join(metadata.titles[0].split()).replace("\\", "\\\\").replace("[", "\\[").replace("]", "\\]")
        description = " ".join(metadata.descriptions[0].split())
        lines.append(f"- [{title}]({page_url(site, path)}): {description}")
        count += 1
    (site / "llms.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Prepared llms.txt ({count} indexable English pages).")


def prepare_notes_example(site):
    """Create a ZIP with public source only and reproducible metadata."""
    source = site / "examples/notes-electron"
    contents = BytesIO()
    with ZipFile(contents, "w") as archive:
        for name in EXAMPLE_FILES:
            entry = ZipInfo(f"notes-example/{name}", (1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            archive.writestr(
                entry,
                (source / name).read_bytes(),
                compress_type=ZIP_DEFLATED,
                compresslevel=9,
            )
    destination = site / "examples/notes-example.zip"
    destination.write_bytes(contents.getvalue())
    print(f"Prepared examples/notes-example.zip ({len(EXAMPLE_FILES)} files).")


def prepare_assets(site, templates):
    """Finish the shared publish artifact before it replaces the current preview."""
    prepare_sharing_image(site)
    prepare_sitemap(site)
    prepare_project_identity(site, templates / "project-identity.json.tmpl")
    prepare_agent_index(site)
    prepare_notes_example(site)


if __name__ == "__main__":
    root = Path(__file__).resolve().parent.parent
    from website_i18n import build_translations
    build_translations(root, root / "website/_site", finalize=lambda site: prepare_assets(site, root / "website/templates"))
