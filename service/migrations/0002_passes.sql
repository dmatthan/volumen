-- A reader's pass for one book: given after their first send passed a person's check
-- (Turnstile), so later sends (made by the app as they read) need none. The pass's
-- SHA-256 only; it goes with the book.
CREATE TABLE passes (
  hash TEXT PRIMARY KEY,
  book TEXT NOT NULL,
  reader TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX passes_book ON passes(book);
