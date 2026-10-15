//! Rich blocks: what the press cannot set from text, drawn instead by the browser as the
//! publisher made it, as a picture in the column (a tap enlarges it, as any image). A
//! genealogy drawn as a table of mostly empty cells with ruled edges, a figure in inline
//! SVG, a formula in MathML: their meaning is in their shape.
//!
//! A rich block is kept as an image whose bytes are well-formed XHTML (the reader draws
//! it inside an SVG `foreignObject`, which shows markup as a picture: no scripts, no
//! fetching, scaled like any image) with the publisher's rules that apply inside it.
//! Colours, faces and backgrounds are left to the reader (ink on transparent, so it sits
//! on any paper; inverted on dark ones); images inside are left out (a picture cannot
//! fetch them), their descriptions kept.

use ego_tree::NodeRef;
use scraper::{ElementRef, Node, Selector};

/// A table that is a drawing rather than a table of data: a third or more of its cells
/// empty (the space a tree's lines run through), or lines drawn with box characters.
pub(crate) fn is_diagram_table(t: &ElementRef) -> bool {
    let cells: Vec<_> = t.descendent_elements().filter(|e| matches!(e.value().name(), "td" | "th")).collect();
    if cells.len() < 12 {
        return false;
    }
    let lines = |s: &str| !s.trim().is_empty() && s.trim().chars().all(|c| "│─┬┴├┤┌┐└┘┼|/\\_—–-=┃━ ".contains(c));
    let empty = cells.iter().filter(|c| { let t: String = c.text().collect(); t.trim().is_empty() || lines(&t) }).count();
    empty * 3 >= cells.len()
}

/// An inline SVG that is a figure of its own (not the cover's frame around one image).
pub(crate) fn is_figure_svg(e: &ElementRef) -> bool {
    let kids: Vec<_> = e.descendent_elements().map(|d| d.value().name().to_ascii_lowercase()).collect();
    !(kids.iter().any(|n| n == "image") && !kids.iter().any(|n| matches!(n.as_str(), "text" | "path" | "line" | "rect" | "circle" | "polyline" | "polygon")))
}

const VOID: &[&str] = &["br", "hr", "col", "wbr", "area", "base", "link", "meta", "source", "track", "param", "embed", "input"];

fn esc(s: &str, attr: bool) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' if attr => o.push_str("&quot;"),
            '\u{a0}' => o.push_str("&#160;"),
            _ => o.push(c),
        }
    }
    o
}

/// The element as XHTML: well-formed, namespaces where SVG and MathML begin, no
/// scripts, handlers or links out; images as their descriptions.
pub(crate) fn xhtml(e: &ElementRef) -> String {
    let mut out = String::new();
    write(**e, &mut out, "");
    out
}

fn write(n: NodeRef<Node>, out: &mut String, ns: &str) {
    match n.value() {
        Node::Text(t) => out.push_str(&esc(t, false)),
        Node::Element(el) => {
            let name = el.name().to_ascii_lowercase();
            if matches!(name.as_str(), "script" | "style" | "iframe" | "object" | "audio" | "video" | "noscript") {
                return;
            }
            if name == "img" {
                if let Some(alt) = el.attr("alt").filter(|a| !a.trim().is_empty()) {
                    out.push_str(&format!("<span>{}</span>", esc(alt, false)));
                }
                return;
            }
            // (SVG's own names keep their case: viewBox, linearGradient)
            let tag = el.name().to_string();
            let own_ns = match name.as_str() {
                "svg" if ns != "svg" => Some(("svg", "http://www.w3.org/2000/svg")),
                "math" if ns != "math" => Some(("math", "http://www.w3.org/1998/Math/MathML")),
                _ => None,
            };
            out.push('<');
            out.push_str(&tag);
            if let Some((_, uri)) = own_ns {
                out.push_str(&format!(" xmlns=\"{uri}\""));
            }
            for (k, v) in el.attrs() {
                let kl = k.to_ascii_lowercase();
                if kl.starts_with("on") || kl == "xmlns" || kl.starts_with("xmlns:") || kl.contains(':') && !kl.starts_with("xml:") || kl == "src" || kl == "srcset" {
                    continue;
                }
                if (kl == "href" || kl.ends_with(":href")) && !v.starts_with('#') {
                    continue;
                }
                out.push_str(&format!(" {k}=\"{}\"", esc(v, true)));
            }
            let child_ns = own_ns.map(|(n, _)| n).unwrap_or(if name == "foreignobject" { "" } else { ns });
            if VOID.contains(&name.as_str()) && ns.is_empty() {
                out.push_str("/>");
                return;
            }
            out.push('>');
            for c in n.children() {
                write(c, out, child_ns);
            }
            out.push_str(&format!("</{tag}>"));
        }
        _ => {}
    }
}

/// The publisher's rules that apply inside `e`, made safe to draw on any paper: no
/// faces, colours, backgrounds, positions fixed to the page or links out; a border's
/// colour follows the ink.
pub(crate) fn styles_for(e: &ElementRef, rules: &[(String, String)]) -> String {
    let inside: Vec<ElementRef> = std::iter::once(*e).chain(e.descendent_elements()).collect();
    let mut out = String::new();
    for (sel, decls) in rules {
        let Ok(s) = Selector::parse(sel) else { continue };
        if !inside.iter().any(|x| s.matches(x)) {
            continue;
        }
        let kept: Vec<String> = decls
            .split(';')
            .filter_map(|d| {
                let (k, v) = d.split_once(':')?;
                let k = k.trim().to_ascii_lowercase();
                let v = v.trim();
                if k.starts_with("font-family") || k == "color" || k.starts_with("background") || k == "position" || v.contains("url(") || k.starts_with("-") {
                    return None;
                }
                if k.starts_with("border") {
                    // a border's own colour gives way to the ink's
                    let v = v.split_whitespace().map(|w| if w.starts_with('#') || w.starts_with("rgb") || is_colour_name(w) { "currentColor" } else { w }).collect::<Vec<_>>().join(" ");
                    return Some(format!("{k}: {v}"));
                }
                Some(format!("{k}: {v}"))
            })
            .collect();
        if !kept.is_empty() {
            out.push_str(&format!("{sel} {{ {} }}\n", kept.join("; ")));
        }
    }
    out
}

fn is_colour_name(w: &str) -> bool {
    matches!(w.to_ascii_lowercase().trim_end_matches([';', ',']), "black" | "white" | "gray" | "grey" | "silver" | "red" | "blue" | "green" | "navy" | "maroon" | "darkgray" | "darkgrey" | "lightgray" | "lightgrey" | "dimgray" | "dimgrey")
}

/// A rich block as stored: the element and its styles, in one XHTML fragment.
pub(crate) fn fragment(e: &ElementRef, rules: &[(String, String)]) -> String {
    let css = styles_for(e, rules);
    format!("<div class=\"vol-rich\"><style>{}</style>{}</div>", esc(&css, false).replace("&gt;", ">"), xhtml(e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use scraper::Html;

    fn first<'a>(d: &'a Html, sel: &str) -> ElementRef<'a> {
        d.select(&Selector::parse(sel).unwrap()).next().unwrap()
    }

    #[test]
    fn a_genealogy_table_is_a_drawing_a_price_list_is_not() {
        let tree = Html::parse_document(&format!(
            "<table class=\"g\">{}</table>",
            "<tr><td></td><td>Edward III</td><td></td></tr><tr><td class=\"br\"></td><td></td><td class=\"bl\"></td></tr><tr><td>Lionel</td><td></td><td>John</td></tr><tr><td>│</td><td></td><td>│</td></tr>"
        ));
        assert!(is_diagram_table(&first(&tree, "table")));
        let data = Html::parse_document(&format!("<table>{}</table>", "<tr><td>Bread</td><td>2d</td><td>daily</td></tr>".repeat(5)));
        assert!(!is_diagram_table(&first(&data, "table")));
    }

    #[test]
    fn written_out_well_formed_with_its_styles_made_safe() {
        let d = Html::parse_document(r#"<table class="g" onclick="x()"><tr><td class="br">Edward<br>III &amp; heirs<img src="a.png" alt="crest"></td></tr></table><svg viewBox="0 0 10 10"><path d="M0 0L10 10"/></svg>"#);
        let x = xhtml(&first(&d, "table"));
        assert!(!x.contains("onclick") && !x.contains("a.png"));
        assert!(x.contains("Edward<br/>III &amp; heirs<span>crest</span>"), "{x}");
        let s = xhtml(&first(&d, "svg"));
        assert!(s.starts_with("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 10 10\">"), "{s}");
        let css = styles_for(&first(&d, "table"), &[(".br".into(), "border-right: 1px solid #000; color: red; font-family: Garamond".into()), (".other".into(), "border: 1px solid black".into())]);
        assert_eq!(css, ".br { border-right: 1px solid currentColor }\n");
    }
}
