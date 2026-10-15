/** The book as the reader receives it (offsets are UTF-16). Mirrors vol_model::js. */
/** What the importer makes of a file, as a number: `vol_ingest::VERSION` (keep the same).
 *  Books read by an earlier one are read again from their kept file (reader/reread.ts). */
export const IMPORTER_VERSION = 3;

export interface BookData {
  id: string;
  title: string;
  subtitle: string;
  author: string;
  year: string;
  lang: string;
  words: number;
  sections: SectionData[];
  notes: NoteData[];
  /** Each image's width and height (CSS px) and description. */
  /** Width, height (0 for a rich block not yet measured), description, type. */
  images: [number, number, string, string][];
  /** Its characters beyond the bundled faces' core files (fonts.css), each once; empty
   *  for most books. The extension faces that have them are loaded for it. */
  ext: string;
}
export interface SectionData {
  /** 0 front matter, 1 chapter */
  k: 0 | 1;
  part: string;
  label: string;
  num: string;
  title: string;
  blocks: BlockData[];
}
export interface BlockData {
  k: BlockKind;
  key: string;
  t: string;
  /** start, end, style triples */
  r: number[];
  /** Links: start, end, and where to: `n:12` a note, `b:<key>` a block, `u:<url>` the web. */
  l?: [number, number, string][];
  /** An image block's image. */
  img?: number;
  /** A table's shape: columns, header rows, each cell's column span. */
  tb?: { cols: number; header_rows: number; spans: number[] };
}
export interface NoteData { label: string; t: string; r: number[]; at: string | null }
export const enum BlockKind { P = 0, H = 1, Q = 2, Li = 3, Verse = 4, Attrib = 5, Sign = 6, Center = 7, Break = 8, Image = 9, Table = 10, Pre = 11 }
export const enum Style { Italic = 1, Bold = 2, SmallCaps = 4, Sup = 8, Sub = 16 }

export interface LayoutParams {
  size: number;
  measure: number;
  rows: number;
  headRows: number;
  justify: boolean;
  hyphenate: boolean;
  /** Row height, px (images fill whole rows). */
  lh: number;
  /** Glyph advances rounded to whole px (webviews without subpixel positioning). */
  round: boolean;
  /** Glyph advances rounded to 1/60 px (Firefox lays text out in such units). */
  appUnits?: boolean;
  /** Families in fallback order. */
  font: string[];
  /** Weights of body text and bold. */
  wght: number;
  bold: number;
  /** Letter spacing and extra word spacing, px. */
  ls: number;
  ws: number;
  /** Further font axes, e.g. ["SOFT", 50]. */
  axes: [string, number][];
  /** How the webview kerns around word spaces, for faces that kern with the space:
   *  0 not at all, 1 a glyph with the space after it (WebKit), 2 both sides (Chromium). */
  spaceKern: 0 | 1 | 2;
  /** The webview shapes each inline element on its own: no kerning across a link's edge
   *  (WebKit). */
  linkRuns: boolean;
}

/** A font family as the engine loaded it. */
export interface FamilyLoad {
  bundled: boolean;
  /** Has real small capitals; without them the press and the CSS synthesise them. */
  smcp: boolean;
  italic: boolean;
  /** System families: the files the webview must load too (fetched with fontFile). */
  files: { italic: boolean; wmin: number; wmax: number }[];
}

/** Where a note was: its block, UTF-16 offsets, the words and a little either side, and
 *  how far through the book (0–1), if known. */
export interface NoteAnchor { key: string; s: number; e: number; quote: string; prefix: string; suffix: string; pos?: number }
/** Where it is now. `same`: unmoved; `moved`: the same words elsewhere; `changed`: the
 *  words were reworded; `lost`: not found (key and offsets as they were). */
export interface Placed { key: string; s: number; e: number; how: 'same' | 'moved' | 'changed' | 'lost' }

/** A match found by library search, with the words around it. */
export interface LibHit { sec: number; block: number; key: string; s: number; e: number; chapter: string; before: string; matched: string; after: string }
/** A book's matches: how many, whether the phrase (else paragraphs with every word), the first few. */
export interface BookHits { id: string; total: number; phrase: boolean; hits: LibHit[] }

/** A note as a Word comment: the words, a little either side, who, what (annotate.rs). */
export interface WordComment { quote: string; prefix: string; suffix: string; author: string; text: string; date: string }

export interface LibEntry {
  id: string;
  title: string;
  author: string;
  year: string;
  words: number;
  chapters: number;
  added: number;
  sample?: boolean;
  cover?: boolean;
  /** The importer's version that read it (none: before versions were kept), and whether
   *  its file is kept to be read again by a later one. */
  importer?: number;
  source?: boolean;
}

/** What the reader needs from the engine, whichever shell hosts it. */
export interface Core {
  /** Reads a file into the library; with `chapters`, only those (an extract, web only). */
  importFile(bytes: Uint8Array, name: string, chapters?: [number, number]): Promise<LibEntry>;
  /** The book's content; loads it from storage if needed. */
  open(id: string): Promise<BookData>;
  /** Encoded layout table for the given sections (all when empty). */
  layout(id: string, sections: number[], p: LayoutParams): Promise<ArrayBuffer>;
  remove(id: string): Promise<void>;
  /** Find in book: `[total, phrase, (sec, block, s, e, near) × hits]`, UTF-16 offsets. */
  find(id: string, query: string, limit: number): Promise<Uint32Array>;
  /** What a book needs beyond its theme's first face (loaded first): the characters
   *  that face lacks (the fallback faces are fetched only for them) and whether it has
   *  preformatted text (the monospaced face). */
  fontNeeds(id: string, family: string): Promise<{ fallback: string; pre: boolean }>;
  /** Places notes on a book, as it is now (a later draft, or after a re-import): where
   *  each belongs and how it was found (see crates/engine/src/anchor.rs). */
  place(id: string, anchors: NoteAnchor[]): Promise<Placed[]>;
  /** Search every book's text: books with the most matches first, each with its first few
   *  in context (see crates/engine/src/search.rs). */
  searchLibrary(query: string): Promise<BookHits[]>;
  /** [exact, whole px, 1/60 px] widths of each probe string in body text. */
  probe(p: LayoutParams, texts: string[]): Promise<number[]>;
  /** Makes a family available to the press: bundled, or (desktop) installed. */
  loadFamily(name: string): Promise<FamilyLoad>;
  /** One file of a loaded system family. */
  fontFile?(name: string, index: number): Promise<ArrayBuffer>;
  /** Families installed on this computer (desktop only). */
  systemFamilies?(): Promise<string[]>;
  /** The desktop's own colours where it publishes them (Omarchy), else null. */
  desktopPalette?(): Promise<Record<string, string> | null>;
  library(): Promise<LibEntry[]>;
  /** A URL the webview can show a book's image from. */
  imageURL(id: string, idx: number): string | Promise<string>;
  /** No book is open now: an engine that costs memory may end after a while (the web
   *  build's worker), starting again when next asked. */
  idle?(): void;
  /** The cover image's bytes (empty when there is none). */
  cover(id: string): Promise<ArrayBuffer>;
  /** A book's kept file (its name tells its kind), or nothing if it was not kept. */
  source(id: string): Promise<{ name: string; bytes: Uint8Array } | null>;
  /** Reads a book again from its kept file, with the importer as it is now. */
  reimport(id: string): Promise<LibEntry>;
  /** An image's bytes (a rich block's XHTML). */
  imageBytes(id: string, idx: number): Promise<ArrayBuffer>;
  /** Readers' notes put into a Word file as Word comments, found there by their words:
   *  the file again, how many were placed, and which were not. */
  annotateDocx(docx: Uint8Array, notes: WordComment[]): Promise<{ bytes: Uint8Array; placed: number; unplaced: number[] }>;
  /** Chapters `from` to `to` of a file (a book's kept file) as an EPUB of their own: a
   *  sample to put online, or a manuscript as an EPUB. */
  epubOf(bytes: Uint8Array, name: string, from: number, to: number): Promise<Uint8Array>;
  /** Sizes measured for rich blocks, `[index, w, h]`, kept with the book. */
  setImageSizes(id: string, sizes: [number, number, number][]): Promise<void>;
  /** Replaces the cover with a smaller image of it (the library's thumbnail). */
  setCover(id: string, bytes: ArrayBuffer): Promise<void>;
  /** Files the engine fetched (web build), for the service worker to keep. */
  fetched?(): Promise<string[]>;
  /** Native file picker (desktop app); the web build uses a file input instead. */
  pick?(): Promise<{ kind: 'book'; entry: LibEntry } | { kind: 'notes'; text: string } | { kind: 'backup'; file: Blob } | null>;
}
