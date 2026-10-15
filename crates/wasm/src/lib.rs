//! The engine for the web build, run inside a Web Worker.

use std::sync::Mutex;
use vol_engine::{Engine as Inner, Request};
use wasm_bindgen::prelude::*;

/// The last panic's message and place. The build aborts on a panic (the instance traps,
/// and the engine object stays borrowed for good), so the worker reads this afterwards to
/// say what went wrong, then starts a new instance.
static PANIC: Mutex<String> = Mutex::new(String::new());

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console, js_name = error)]
    fn console_error(s: &str);
}

/// The importer's version (`vol_ingest::VERSION`).
#[wasm_bindgen(js_name = importerVersion)]
pub fn importer_version() -> u32 {
    vol_engine::IMPORTER_VERSION
}

/// Records panics (see `PANIC`); called once, after the module is loaded.
#[wasm_bindgen(js_name = catchPanics)]
pub fn catch_panics() {
    std::panic::set_hook(Box::new(|info| {
        let msg = info.to_string();
        console_error(&msg);
        if let Ok(mut p) = PANIC.lock() {
            *p = msg;
        }
    }));
}

/// The message of the panic that stopped this instance, if one did.
#[wasm_bindgen(js_name = lastPanic)]
pub fn last_panic() -> String {
    PANIC.lock().map(|p| p.clone()).unwrap_or_default()
}

#[wasm_bindgen]
pub struct Engine(Inner);

#[wasm_bindgen]
impl Engine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Engine {
        Engine(Inner::new())
    }

    /// Adds one font file to a family.
    #[wasm_bindgen(js_name = addFont)]
    pub fn add_font(&mut self, family: &str, bytes: Vec<u8>) -> Result<(), JsError> {
        self.0.add_font(family, bytes).map_err(|e| JsError::new(&e))
    }

    /// Adds a language's hyphenation patterns (`/hyph/<code>.bin`).
    #[wasm_bindgen(js_name = addPatterns)]
    pub fn add_patterns(&mut self, code: &str, bytes: Vec<u8>) -> Result<(), JsError> {
        self.0.add_patterns(code, bytes).map_err(|e| JsError::new(&e))
    }

    /// The language whose patterns a book needs and the engine lacks, if any.
    #[wasm_bindgen(js_name = patternsWanted)]
    pub fn patterns_wanted(&self, id: &str) -> Option<String> {
        self.0.patterns_wanted(id).map(str::to_string)
    }

    /// What a book needs beyond its theme's face (JSON; see `Engine::font_needs`).
    #[wasm_bindgen(js_name = fontNeeds)]
    pub fn font_needs(&self, id: &str, family: &str) -> Option<String> {
        self.0.font_needs(id, family)
    }

    /// The book has characters beyond the bundled faces' core files.
    #[wasm_bindgen(js_name = extWanted)]
    pub fn ext_wanted(&self, id: &str) -> bool {
        self.0.ext_wanted(id)
    }

    #[wasm_bindgen(js_name = hasFamily)]
    pub fn has_family(&self, family: &str) -> bool {
        self.0.has_family(family)
    }

    /// JSON: files, smcp, italic, weights.
    #[wasm_bindgen(js_name = familyInfo)]
    pub fn family_info(&self, family: &str) -> Option<String> {
        self.0.family_info(family).and_then(|i| serde_json::to_string(&i).ok())
    }

    /// Reads an EPUB or text file and returns the book id.
    pub fn import(&mut self, bytes: &[u8], name: &str) -> Result<String, JsError> {
        self.0.import(bytes, name).map_err(|e| JsError::new(&e))
    }

    pub fn restore(&mut self, bytes: &[u8]) -> Result<String, JsError> {
        self.0.restore(bytes).map_err(|e| JsError::new(&e))
    }

    pub fn save(&self, id: &str) -> Option<Vec<u8>> {
        self.0.save(id)
    }

    /// Cover bytes found at import, if any.
    pub fn cover(&self, id: &str) -> Option<Vec<u8>> {
        self.0.cover(id).map(|c| c.bytes.clone())
    }

    /// Images found at import: how many, and each one's bytes and type.
    #[wasm_bindgen(js_name = imageCount)]
    pub fn image_count(&self, id: &str) -> usize {
        self.0.book(id).map(|b| b.images.len()).unwrap_or(0)
    }

    #[wasm_bindgen(js_name = imageBytes)]
    pub fn image_bytes(&self, id: &str, idx: usize) -> Option<Vec<u8>> {
        self.0.image(id, idx).map(|i| i.bytes.clone())
    }

    /// Sizes measured by the reader for rich blocks: `[index, w, h] × n`, flattened.
    #[wasm_bindgen(js_name = setImageSizes)]
    pub fn set_image_sizes(&mut self, id: &str, sizes: &[u32]) -> bool {
        let s: Vec<(u32, u32, u32)> = sizes.chunks_exact(3).map(|c| (c[0], c[1], c[2])).collect();
        self.0.set_image_sizes(id, &s)
    }

    #[wasm_bindgen(js_name = imageMime)]
    pub fn image_mime(&self, id: &str, idx: usize) -> Option<String> {
        self.0.image(id, idx).map(|i| i.mime.clone())
    }

    pub fn has(&self, id: &str) -> bool {
        self.0.has(id)
    }

    pub fn forget(&mut self, id: &str) {
        self.0.forget(id)
    }

    #[wasm_bindgen(js_name = bookJson)]
    pub fn book_json(&self, id: &str) -> Option<String> {
        self.0.book_json(id)
    }

    /// Exact and rounded widths of each probe string, flattened.
    /// Find in book: `[total, phrase, (sec, block, s, e, near) × hits]`.
    pub fn find(&mut self, id: &str, query: &str, limit: usize) -> Option<Vec<u32>> {
        self.0.find(id, query, limit)
    }

    /// Places notes on a book: `anchors` and the result are JSON (see `vol_engine::anchor`).
    pub fn place(&self, id: &str, anchors: &str) -> Result<String, JsError> {
        let a: Vec<vol_engine::anchor::Anchor> = serde_json::from_str(anchors).map_err(|e| JsError::new(&e.to_string()))?;
        let p = self.0.place(id, &a).ok_or_else(|| JsError::new("missing book"))?;
        serde_json::to_string(&p).map_err(|e| JsError::new(&e.to_string()))
    }

    /// Library search in one saved book (the web build looks through each in turn, having
    /// no full-text index): its matches as JSON, or nothing.
    #[wasm_bindgen(js_name = searchSaved)]
    pub fn search_saved(&self, bytes: &[u8], query: &str, keep: usize) -> Option<String> {
        let book = vol_engine::Book::restore(bytes).ok()?;
        vol_engine::search::in_book(&book, None, query, keep).and_then(|h| serde_json::to_string(&h).ok())
    }

    /// `request` is the layout request as JSON.
    pub fn probe(&mut self, request: &str, texts: Vec<String>) -> Result<Vec<f32>, JsError> {
        let r: Request = serde_json::from_str(request).map_err(|e| JsError::new(&e.to_string()))?;
        let t: Vec<&str> = texts.iter().map(String::as_str).collect();
        Ok(self.0.probe(&r, &t).map_err(|e| JsError::new(&e))?.into_iter().flat_map(|(a, b, c)| [a, b, c]).collect())
    }

    pub fn layout(&mut self, id: &str, sections: &[u32], request: &str) -> Result<Vec<u8>, JsError> {
        let r: Request = serde_json::from_str(request).map_err(|e| JsError::new(&e.to_string()))?;
        self.0.layout(id, sections, &r).map_err(|e| JsError::new(&e))
    }
}

/// Panics, for the tests of what the page does when the engine fails.
#[wasm_bindgen(js_name = faultForTest)]
pub fn fault_for_test() {
    panic!("a fault made on purpose");
}

/// The writer's Word file with readers' notes as Word comments, and what was placed
/// (`vol_engine::annotate_docx`).
#[wasm_bindgen]
pub struct Annotated {
    bytes: Vec<u8>,
    report: String,
}

#[wasm_bindgen]
impl Annotated {
    #[wasm_bindgen(getter)]
    pub fn bytes(&self) -> Vec<u8> {
        self.bytes.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn report(&self) -> String {
        self.report.clone()
    }
}

#[wasm_bindgen(js_name = annotateDocx)]
pub fn annotate_docx(docx: &[u8], comments: &str) -> Result<Annotated, JsError> {
    let (bytes, report) = vol_engine::annotate_docx(docx, comments).map_err(|e| JsError::new(&e))?;
    Ok(Annotated { bytes, report })
}
