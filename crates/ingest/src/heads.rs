//! Chapter headings: "CHAPTER IV. THE TALE OF A DETECTIVE" → label, number, title.

const WORDS: &[&str] = &["chapter", "book", "part", "canto", "letter", "section", "volume", "act", "scene", "stave", "lecture"];

pub struct Head {
    pub label: String,
    pub num: String,
    pub title: String,
}

fn is_number(w: &str) -> bool {
    let w = w.trim_end_matches(['.', ':']);
    !w.is_empty()
        && (w.chars().all(|c| c.is_ascii_digit())
            || w.chars().all(|c| matches!(c.to_ascii_uppercase(), 'I' | 'V' | 'X' | 'L' | 'C' | 'D' | 'M'))
            || WORD_NUMS.contains(&w.to_lowercase().as_str()))
}

const WORD_NUMS: &[&str] = &[
    "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "first", "second",
    "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "last",
];

/// Splits a heading into label ("Chapter IV"), number ("IV") and title.
pub fn parse(text: &str) -> Head {
    let t = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let t = t.trim().trim_end_matches('.').trim().to_string();
    let words: Vec<&str> = t.split(' ').collect();
    if words.len() >= 2 && WORDS.contains(&words[0].to_lowercase().as_str()) && is_number(words[1]) {
        let num = words[1].trim_end_matches(['.', ':']).to_string();
        let num = if num.chars().all(|c| c.is_ascii_alphabetic()) && num.len() <= 8 && is_roman(&num) {
            num.to_uppercase()
        } else {
            title_case(&num)
        };
        let label = format!("{} {}", cap(&words[0].to_lowercase()), num);
        let rest = words[2..].join(" ");
        let rest = rest.trim_start_matches(['.', ':', '—', '-', ' ']).trim();
        return Head { label, num, title: tidy(rest) };
    }
    if words.len() == 1 && is_number(words[0]) && is_roman(words[0].trim_end_matches('.')) {
        let num = words[0].trim_end_matches('.').to_uppercase();
        return Head { label: String::new(), num, title: String::new() };
    }
    Head { label: String::new(), num: String::new(), title: tidy(&t) }
}

fn is_roman(w: &str) -> bool {
    !w.is_empty() && w.chars().all(|c| matches!(c.to_ascii_uppercase(), 'I' | 'V' | 'X' | 'L' | 'C' | 'D' | 'M'))
}

/// Title-cases text that arrives in capitals; leaves mixed case alone.
pub fn tidy(s: &str) -> String {
    let s = s.trim().trim_end_matches('.').trim();
    if s.chars().any(|c| c.is_lowercase()) {
        return s.to_string();
    }
    title_case(s)
}

const SMALL: &[&str] = &["of", "the", "in", "a", "an", "and", "to", "on", "at", "by", "for", "or", "with", "from"];

pub fn title_case(s: &str) -> String {
    s.split(' ')
        .enumerate()
        .map(|(i, w)| {
            let lw = w.to_lowercase();
            if i > 0 && SMALL.contains(&lw.as_str()) {
                lw
            } else if is_roman(w) && w.len() <= 6 && w.chars().all(|c| c.is_uppercase()) && i > 0 {
                w.to_string()
            } else {
                cap(&lw)
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn cap(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut first = true;
    for c in s.chars() {
        if first && c.is_alphabetic() {
            out.extend(c.to_uppercase());
            first = false;
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chapter_with_title() {
        let h = parse("CHAPTER I. THE TWO POETS OF SAFFRON PARK");
        assert_eq!((h.label.as_str(), h.num.as_str(), h.title.as_str()), ("Chapter I", "I", "The Two Poets of Saffron Park"));
    }

    #[test]
    fn bare_chapter() {
        let h = parse("CHAPTER XII.");
        assert_eq!((h.label.as_str(), h.num.as_str(), h.title.as_str()), ("Chapter XII", "XII", ""));
        let h = parse("Book I. Miss Brooke.");
        assert_eq!((h.label.as_str(), h.title.as_str()), ("Book I", "Miss Brooke"));
    }

    #[test]
    fn plain_title() {
        assert_eq!(parse("PRELUDE.").title, "Prelude");
        assert_eq!(parse("Preface").title, "Preface");
    }
}
