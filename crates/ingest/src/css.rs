//! The publisher's styles, as far as they change what the press sets: what is hidden
//! (`display: none`, `visibility: hidden`: a Kindle-only heading, a layout note, a page
//! number kept for print), and italic, bold, small capitals, superscript and subscript
//! given by class rather than by tag (InDesign, Calibre and most commercial EPUBs).
//! Layout (margins, sizes, faces, colours) is the theme's, never the publisher's.
//!
//! Selectors are matched by the HTML parser's own engine (scraper), so they mean what
//! they mean in a browser; the cascade is specificity, then source order, then the
//! element's own `style`. `@media` rules for print or for Kindle are left out; rules on
//! pseudo-elements (`::before`, `:first-letter`) cannot change text and are skipped.

use ego_tree::NodeId;
use scraper::{ElementRef, Html, Selector};
use std::collections::HashMap;

/// What a rule (or the cascade) says of an element; `None` where it says nothing.
#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub(crate) struct Props {
    pub hidden: Option<bool>,
    pub italic: Option<bool>,
    pub bold: Option<bool>,
    pub smcp: Option<bool>,
    /// 1 superscript, -1 subscript, 0 on the baseline.
    pub va: Option<i8>,
    /// A block's alignment: 0 the text's own (left, justified), 1 centred, 2 right.
    pub align: Option<u8>,
}

impl Props {
    fn any(&self) -> bool {
        *self != Props::default()
    }
    fn over(&mut self, o: &Props) {
        self.hidden = o.hidden.or(self.hidden);
        self.italic = o.italic.or(self.italic);
        self.bold = o.bold.or(self.bold);
        self.smcp = o.smcp.or(self.smcp);
        self.va = o.va.or(self.va);
        self.align = o.align.or(self.align);
    }
}

/// A style sheet's rules that matter here: (selector text, what it says).
pub(crate) type Sheet = Vec<(String, Props)>;

/// Reads a style sheet (a file's, or a `<style>` element's).
pub(crate) fn parse_sheet(src: &str) -> Sheet {
    let mut out = Vec::new();
    rules(&strip_comments(src), &mut out);
    out
}

fn strip_comments(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find("/*") {
        out.push_str(&rest[..i]);
        rest = rest[i + 2..].find("*/").map(|j| &rest[i + 2 + j + 2..]).unwrap_or("");
    }
    out.push_str(rest);
    out
}

/// The block that starts after `open` (the index of a '{'): its inside, and where it ends.
fn block(s: &str, open: usize) -> (&str, usize) {
    let mut depth = 0;
    for (i, c) in s[open..].char_indices() {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return (&s[open + 1..open + i], open + i + 1);
                }
            }
            _ => {}
        }
    }
    (&s[open + 1..], s.len())
}

fn rules(s: &str, out: &mut Sheet) {
    let mut at = 0;
    while at < s.len() {
        let rest = s[at..].trim_start();
        at = s.len() - rest.len();
        if rest.is_empty() {
            break;
        }
        let open = rest.find('{');
        // a statement at-rule (@import, @charset, @namespace): to its ';'
        if rest.starts_with('@') {
            let semi = rest.find(';');
            if semi.is_some_and(|i| open.is_none_or(|o| i < o)) {
                at += semi.unwrap() + 1;
                continue;
            }
        }
        let Some(open) = open else { break };
        let prelude = rest[..open].trim();
        let (inside, end) = block(rest, open);
        at += end;
        if let Some(at_rule) = prelude.strip_prefix('@') {
            let lower = at_rule.to_ascii_lowercase();
            if (lower.starts_with("media") && media_applies(&lower[5..])) || lower.starts_with("supports") {
                rules(inside, out);
            }
            continue;
        }
        let props = declarations(inside);
        if !props.any() {
            continue;
        }
        for sel in prelude.split(',') {
            let sel = sel.trim();
            let l = sel.to_ascii_lowercase();
            if sel.is_empty() || l.contains("::") || [":before", ":after", ":first-letter", ":first-line", ":hover", ":focus", ":active", ":visited"].iter().any(|p| l.contains(p)) {
                continue;
            }
            out.push((sel.to_string(), props));
        }
    }
}

/// `@media` for screens (or all): not print, not Kindle (`amzn-kf8`, `amzn-mobi`).
fn media_applies(q: &str) -> bool {
    !(q.contains("amzn") || q.contains("kindle") || (q.contains("print") && !q.contains("screen")) || q.contains("speech"))
}

pub(crate) fn declarations(src: &str) -> Props {
    let mut p = Props::default();
    for d in src.split(';') {
        let Some((name, value)) = d.split_once(':') else { continue };
        let name = name.trim().to_ascii_lowercase();
        let v = value.to_ascii_lowercase().replace("!important", "");
        let v = v.trim();
        match name.as_str() {
            "display" => p.hidden = Some(v == "none"),
            "visibility" => p.hidden = Some(v == "hidden" || v == "collapse"),
            "font-style" => p.italic = Some(v.starts_with("italic") || v.starts_with("oblique")),
            "font-weight" => p.bold = weight(v),
            "font-variant" | "font-variant-caps" => p.smcp = Some(v.contains("small-caps")),
            "text-align" => {
                p.align = match v {
                    "center" | "-webkit-center" => Some(1),
                    "right" | "end" => Some(2),
                    "left" | "start" | "justify" => Some(0),
                    _ => None,
                }
            }
            "vertical-align" => {
                p.va = match v {
                    "super" | "text-top" => Some(1),
                    "sub" | "text-bottom" => Some(-1),
                    "baseline" => Some(0),
                    _ => None,
                }
            }
            "font" => {
                for w in v.split_whitespace() {
                    match w {
                        "italic" | "oblique" => p.italic = Some(true),
                        "small-caps" => p.smcp = Some(true),
                        _ => {
                            if let Some(b) = weight(w).filter(|_| w != "normal") {
                                p.bold = Some(b);
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
    p
}

fn weight(v: &str) -> Option<bool> {
    match v {
        "bold" | "bolder" => Some(true),
        "normal" | "lighter" => Some(false),
        _ => v.parse::<u32>().ok().map(|n| n >= 600),
    }
}

/// (ids, classes and attributes and pseudo-classes, elements), counted from the text.
fn specificity(sel: &str) -> (u16, u16, u16) {
    let (mut a, mut b, mut c) = (0, 0, 0);
    let mut chars = sel.chars().peekable();
    let mut prev_boundary = true;
    while let Some(ch) = chars.next() {
        match ch {
            '#' => a += 1,
            '.' | '[' | ':' => b += 1,
            ' ' | '>' | '+' | '~' | '(' | ')' | '*' => {}
            _ if prev_boundary && ch.is_ascii_alphabetic() => c += 1,
            _ => {}
        }
        prev_boundary = matches!(ch, ' ' | '>' | '+' | '~' | '(');
        if ch == '[' {
            for x in chars.by_ref() {
                if x == ']' {
                    break;
                }
            }
        }
    }
    (a, b, c)
}

/// The cascade over one document: what applies to each element that any rule touches
/// (each element's own; inheritance is the reader's: italic flows into children as the
/// text is gathered).
pub(crate) fn cascade(doc: &Html, sheets: &[&Sheet]) -> HashMap<NodeId, Props> {
    let mut hits: HashMap<NodeId, Vec<((u16, u16, u16), usize, Props)>> = HashMap::new();
    let mut order = 0;
    for sheet in sheets {
        for (sel, props) in sheet.iter() {
            order += 1;
            let Ok(s) = Selector::parse(sel) else { continue };
            let spec = specificity(sel);
            for el in doc.select(&s) {
                hits.entry(el.id()).or_default().push((spec, order, *props));
            }
        }
    }
    let mut out: HashMap<NodeId, Props> = HashMap::new();
    for (id, mut v) in hits {
        v.sort_by_key(|(spec, ord, _)| (*spec, *ord));
        let mut p = Props::default();
        for (_, _, q) in &v {
            p.over(q);
        }
        out.insert(id, p);
    }
    // an element's own style attribute comes last
    for el in doc.root_element().descendants().filter_map(ElementRef::wrap) {
        if let Some(st) = el.attr("style") {
            let q = declarations(st);
            if q.any() {
                out.entry(el.id()).or_default().over(&q);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_what_matters_and_skips_the_rest() {
        let s = parse_sheet(
            "@charset \"utf-8\"; /* a comment { } */ @import url(x.css);
             p.hide, .x { display: none; margin: 0 }
             span.it { font-style: italic }
             .b { font-weight: 700 } .n { font-weight: 400 }
             .sc { font-variant: small-caps }
             @media amzn-kf8 { .k { display: none } }
             @media screen { .s { display: none } }
             h1::before { content: 'x'; display: none }
             .f { font: italic bold 1em serif }
             .m { margin: 1em }",
        );
        let get = |sel: &str| s.iter().find(|(x, _)| x == sel).map(|(_, p)| *p);
        assert_eq!(get("p.hide").unwrap().hidden, Some(true));
        assert_eq!(get(".x").unwrap().hidden, Some(true));
        assert_eq!(get("span.it").unwrap().italic, Some(true));
        assert_eq!(get(".b").unwrap().bold, Some(true));
        assert_eq!(get(".n").unwrap().bold, Some(false));
        assert_eq!(get(".sc").unwrap().smcp, Some(true));
        assert!(get(".k").is_none(), "Kindle-only rules are not this reader's");
        assert_eq!(get(".s").unwrap().hidden, Some(true));
        assert!(get("h1::before").is_none());
        assert_eq!(get(".f").unwrap(), Props { italic: Some(true), bold: Some(true), ..Props::default() });
        assert!(get(".m").is_none(), "rules that change nothing here are not kept");
    }

    #[test]
    fn specificity_then_order_then_the_element_itself() {
        let doc = Html::parse_document(r#"<html><body><p class="a b" id="p">x</p><p class="a" style="font-style: italic">y</p></body></html>"#);
        let sheet = parse_sheet("p.a { font-style: italic } .a { font-style: normal } #p { display: none } .a.b { font-style: normal }");
        let c = cascade(&doc, &[&sheet]);
        let ps: Vec<_> = doc.select(&Selector::parse("p").unwrap()).collect();
        assert_eq!(c[&ps[0].id()], Props { hidden: Some(true), italic: Some(false), ..Props::default() });
        // p.a (0,1,1) beats .a (0,1,0); the style attribute beats both
        assert_eq!(c[&ps[1].id()].italic, Some(true));
        assert_eq!(specificity("div#x .a > p:first-child[lang]"), (1, 3, 2));
    }
}

thread_local! {
    /// The cascade of the document being read (set per spine document by `epub.rs`).
    static NOW: std::cell::RefCell<HashMap<NodeId, Props>> = std::cell::RefCell::new(HashMap::new());
}

/// Makes `c` the cascade of the document being read.
pub(crate) fn set(c: HashMap<NodeId, Props>) {
    NOW.with(|n| *n.borrow_mut() = c);
}

/// What the publisher's styles say of an element of the document being read.
pub(crate) fn of(e: &ElementRef) -> Props {
    NOW.with(|n| n.borrow().get(&e.id()).copied().unwrap_or_default())
}

/// The element is not shown (`display: none`, `visibility: hidden`).
pub(crate) fn hidden(e: &ElementRef) -> bool {
    of(e).hidden == Some(true)
}

/// A style (vol_model::style) as an element's own declarations change it.
pub(crate) fn apply(st: u8, p: Props) -> u8 {
    use vol_model::style::*;
    let mut st = st;
    let mut set = |on: Option<bool>, bit: u8| match on {
        Some(true) => st |= bit,
        Some(false) => st &= !bit,
        None => {}
    };
    set(p.italic, ITALIC);
    set(p.bold, BOLD);
    set(p.smcp, SMALLCAPS);
    match p.va {
        Some(1) => st = (st | SUP) & !SUB,
        Some(-1) => st = (st | SUB) & !SUP,
        Some(_) => st &= !(SUP | SUB),
        None => {}
    }
    st
}

/// A style sheet's rules as written, (selector, declarations), for what is drawn by the
/// browser as it is (a rich block: `rich.rs`). Only plain style rules: no at-rules.
pub(crate) fn raw_rules(src: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    raw(&strip_comments(src), &mut out);
    out
}

fn raw(s: &str, out: &mut Vec<(String, String)>) {
    let mut at = 0;
    while at < s.len() {
        let rest = s[at..].trim_start();
        at = s.len() - rest.len();
        if rest.is_empty() {
            break;
        }
        let open = rest.find('{');
        if rest.starts_with('@') {
            let semi = rest.find(';');
            if semi.is_some_and(|i| open.is_none_or(|o| i < o)) {
                at += semi.unwrap() + 1;
                continue;
            }
        }
        let Some(open) = open else { break };
        let prelude = rest[..open].trim().to_string();
        let (inside, end) = block(rest, open);
        at += end;
        if let Some(r) = prelude.strip_prefix('@') {
            let l = r.to_ascii_lowercase();
            if (l.starts_with("media") && media_applies(&l[5..])) || l.starts_with("supports") {
                raw(inside, out);
            }
            continue;
        }
        out.push((prelude, inside.trim().to_string()));
    }
}
