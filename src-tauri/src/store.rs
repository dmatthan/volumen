//! The library on disk: one SQLite file with book models and their metadata.

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Serialize, Deserialize, Clone)]
pub struct LibEntry {
    pub id: String,
    pub title: String,
    pub author: String,
    pub year: String,
    pub words: usize,
    pub chapters: usize,
    pub added: u64,
    #[serde(skip_serializing_if = "std::ops::Not::not", default)]
    pub sample: bool,
    #[serde(default)]
    pub cover: bool,
    /// The importer's version that read it (0: before versions were kept), and whether its
    /// file is kept, so a later importer can read it again.
    #[serde(default)]
    pub importer: u32,
    #[serde(default)]
    pub source: bool,
}

pub struct Store {
    db: Connection,
}

impl Store {
    pub fn open(dir: &Path) -> rusqlite::Result<Store> {
        std::fs::create_dir_all(dir).ok();
        let db = Connection::open(dir.join("library.sqlite3"))?;
        db.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS state (
               key TEXT PRIMARY KEY,
               value TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS books (
               id TEXT PRIMARY KEY,
               meta TEXT NOT NULL,
               model BLOB NOT NULL,
               added INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS images (
               book TEXT NOT NULL,
               idx INTEGER NOT NULL,
               mime TEXT NOT NULL,
               bytes BLOB NOT NULL,
               PRIMARY KEY (book, idx)
             );
             -- every paragraph's folded text, for searching the whole library: only the
             -- index is kept (the text is in the models); a row's id is the book's row id,
             -- section and block (book << 32 | section << 20 | block)
             CREATE VIRTUAL TABLE IF NOT EXISTS ftext USING fts5(body, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 0');
             CREATE TABLE IF NOT EXISTS indexed (book TEXT PRIMARY KEY);
             -- each book's file as added, to be read again by a later importer
             CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, name TEXT NOT NULL, bytes BLOB NOT NULL);",
        )?;
        // the indexer writes from its own connection: either side waits its turn
        db.busy_timeout(std::time::Duration::from_secs(10))?;
        // covers arrived after the first schema
        let has_cover = db.prepare("SELECT cover FROM books LIMIT 0").is_ok();
        if !has_cover {
            db.execute_batch("ALTER TABLE books ADD COLUMN cover BLOB;")?;
        }
        Ok(Store { db })
    }

    pub fn put(&self, e: &LibEntry, model: &[u8]) -> rusqlite::Result<()> {
        self.db.execute(
            "INSERT INTO books (id, meta, model, added) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET meta = excluded.meta, model = excluded.model",
            params![e.id, serde_json::to_string(e).unwrap(), model, e.added as i64],
        )?;
        Ok(())
    }

    /// A book's model saved again (sizes measured since it was imported).
    pub fn put_model(&self, id: &str, model: &[u8]) -> rusqlite::Result<()> {
        self.db.execute("UPDATE books SET model = ?2 WHERE id = ?1", params![id, model])?;
        Ok(())
    }

    pub fn put_cover(&self, id: &str, bytes: &[u8]) -> rusqlite::Result<()> {
        self.db.execute("UPDATE books SET cover = ?2 WHERE id = ?1", params![id, bytes])?;
        Ok(())
    }

    pub fn cover(&self, id: &str) -> rusqlite::Result<Option<Vec<u8>>> {
        Ok(self.db.query_row("SELECT cover FROM books WHERE id = ?1", [id], |r| r.get::<_, Option<Vec<u8>>>(0)).optional()?.flatten())
    }

    pub fn put_images(&self, id: &str, images: &[(String, Vec<u8>)]) -> rusqlite::Result<()> {
        let tx = self.db.unchecked_transaction()?;
        tx.execute("DELETE FROM images WHERE book = ?1", [id])?;
        for (i, (mime, bytes)) in images.iter().enumerate() {
            tx.execute("INSERT INTO images (book, idx, mime, bytes) VALUES (?1, ?2, ?3, ?4)", params![id, i as i64, mime, bytes])?;
        }
        tx.commit()
    }

    pub fn image(&self, id: &str, idx: u32) -> rusqlite::Result<Option<(String, Vec<u8>)>> {
        self.db.query_row("SELECT mime, bytes FROM images WHERE book = ?1 AND idx = ?2", params![id, idx as i64], |r| Ok((r.get(0)?, r.get(1)?))).optional()
    }

    pub fn model(&self, id: &str) -> rusqlite::Result<Option<Vec<u8>>> {
        self.db.query_row("SELECT model FROM books WHERE id = ?1", [id], |r| r.get(0)).optional()
    }

    pub fn library(&self) -> rusqlite::Result<Vec<LibEntry>> {
        let mut st = self.db.prepare("SELECT meta FROM books ORDER BY added")?;
        let rows = st.query_map([], |r| r.get::<_, String>(0))?;
        Ok(rows.filter_map(|m| m.ok()).filter_map(|m| serde_json::from_str(&m).ok()).collect())
    }

    /// Every small-state entry (positions, marks, lines, settings), as stored JSON.
    pub fn state(&self) -> rusqlite::Result<Vec<(String, String)>> {
        let mut st = self.db.prepare("SELECT key, value FROM state")?;
        let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect()
    }

    /// Writes a batch of changes in one transaction; `None` deletes the key.
    pub fn put_state(&mut self, changes: &[(String, Option<String>)]) -> rusqlite::Result<()> {
        let tx = self.db.transaction()?;
        for (k, v) in changes {
            match v {
                Some(v) => tx.execute("INSERT INTO state (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![k, v])?,
                None => tx.execute("DELETE FROM state WHERE key = ?1", [k])?,
            };
        }
        tx.commit()
    }

    pub fn remove(&self, id: &str) -> rusqlite::Result<()> {
        self.unindex(id)?;
        self.db.execute("DELETE FROM books WHERE id = ?1", [id])?;
        self.db.execute("DELETE FROM images WHERE book = ?1", [id])?;
        self.db.execute("DELETE FROM sources WHERE id = ?1", [id])?;
        Ok(())
    }

    /// A book's file as added (its name tells its kind).
    pub fn put_source(&self, id: &str, name: &str, bytes: &[u8]) -> rusqlite::Result<()> {
        self.db.execute("INSERT OR REPLACE INTO sources (id, name, bytes) VALUES (?1, ?2, ?3)", params![id, name, bytes])?;
        Ok(())
    }

    pub fn source(&self, id: &str) -> rusqlite::Result<Option<(String, Vec<u8>)>> {
        self.db.query_row("SELECT name, bytes FROM sources WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?))).optional()
    }

    /// A book read again: its images go (the new reading brings its own) and it is
    /// indexed afresh.
    pub fn renew(&self, id: &str) -> rusqlite::Result<()> {
        self.unindex(id)?;
        self.db.execute("DELETE FROM images WHERE book = ?1", [id])?;
        Ok(())
    }

    /* ---------- the library's full-text index ---------- */

    fn book_row(&self, id: &str) -> rusqlite::Result<Option<i64>> {
        self.db.query_row("SELECT rowid FROM books WHERE id = ?1", [id], |r| r.get(0)).optional()
    }

    /// Books not yet in the index.
    pub fn unindexed(&self) -> rusqlite::Result<Vec<String>> {
        let mut st = self.db.prepare("SELECT id FROM books WHERE id NOT IN (SELECT book FROM indexed) ORDER BY added DESC")?;
        let rows = st.query_map([], |r| r.get(0))?;
        rows.collect()
    }

    /// Indexes a book's paragraphs (their folded text), replacing what was there.
    pub fn index(&mut self, id: &str, rows: impl Iterator<Item = (u32, u32, String)>) -> rusqlite::Result<()> {
        let Some(b) = self.book_row(id)? else { return Ok(()) };
        let tx = self.db.transaction()?;
        tx.execute("DELETE FROM ftext WHERE rowid BETWEEN ?1 AND ?2", params![b << 32, (b << 32) | 0xffff_ffff])?;
        {
            let mut ins = tx.prepare("INSERT INTO ftext (rowid, body) VALUES (?1, ?2)")?;
            for (sec, blk, text) in rows {
                // (a section past 4096 or a block past a million is not searchable)
                if sec < 4096 && blk < (1 << 20) {
                    ins.execute(params![(b << 32) | ((sec as i64) << 20) | blk as i64, text])?;
                }
            }
        }
        tx.execute("INSERT OR IGNORE INTO indexed (book) VALUES (?1)", [id])?;
        tx.commit()
    }

    pub fn unindex(&self, id: &str) -> rusqlite::Result<()> {
        if let Some(b) = self.book_row(id)? {
            self.db.execute("DELETE FROM ftext WHERE rowid BETWEEN ?1 AND ?2", params![b << 32, (b << 32) | 0xffff_ffff])?;
        }
        self.db.execute("DELETE FROM indexed WHERE book = ?1", [id])?;
        Ok(())
    }

    /// Paragraphs matching an FTS5 expression, grouped by book in the order of how many
    /// each has: (book, [(section, block)]).
    pub fn search(&self, expr: &str, limit: usize) -> rusqlite::Result<Vec<(String, Vec<(u32, u32)>)>> {
        let mut ids: std::collections::HashMap<i64, String> = std::collections::HashMap::new();
        {
            let mut st = self.db.prepare("SELECT rowid, id FROM books")?;
            for r in st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))? {
                let (k, v) = r?;
                ids.insert(k, v);
            }
        }
        let mut st = self.db.prepare("SELECT rowid FROM ftext WHERE ftext MATCH ?1 LIMIT ?2")?;
        let mut by: Vec<(String, Vec<(u32, u32)>)> = Vec::new();
        let mut at: std::collections::HashMap<i64, usize> = std::collections::HashMap::new();
        for r in st.query_map(params![expr, limit as i64], |r| r.get::<_, i64>(0))? {
            let row = r?;
            let b = row >> 32;
            let Some(id) = ids.get(&b) else { continue };
            let i = *at.entry(b).or_insert_with(|| {
                by.push((id.clone(), Vec::new()));
                by.len() - 1
            });
            by[i].1.push((((row >> 20) & 0xfff) as u32, (row & 0xf_ffff) as u32));
        }
        by.sort_by_key(|(_, v)| std::cmp::Reverse(v.len()));
        Ok(by)
    }
}
