-- The sharing service (src/index.ts). Only sealed bytes are kept: the service cannot
-- read a book or a note, and knows a book by a random id, its size and its writer.

-- writers: invited people who can publish books; readers have no accounts
CREATE TABLE writers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created INTEGER NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  max_books INTEGER NOT NULL DEFAULT 25,
  max_bytes INTEGER NOT NULL DEFAULT 104857600
);

-- invitations, made with scripts/service.sh: the code's SHA-256 only; `writer` set when
-- the invitation adds a passkey to someone who has one already (a new device)
CREATE TABLE invites (
  hash TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  writer TEXT,
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL,
  used INTEGER
);

CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  writer TEXT NOT NULL,
  pub BLOB NOT NULL,
  counter INTEGER NOT NULL,
  transports TEXT,
  created INTEGER NOT NULL,
  used INTEGER
);
CREATE INDEX passkeys_writer ON passkeys(writer);

-- sessions: the cookie's SHA-256 only
CREATE TABLE sessions (
  hash TEXT PRIMARY KEY,
  writer TEXT NOT NULL,
  expires INTEGER NOT NULL
);

-- a passkey ceremony under way (five minutes)
CREATE TABLE challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  invite TEXT,
  writer TEXT,
  name TEXT,
  expires INTEGER NOT NULL
);

-- a sealed book; `post` is the SHA-256 of the token its link gives readers to send notes
CREATE TABLE books (
  id TEXT PRIMARY KEY,
  writer TEXT NOT NULL,
  size INTEGER NOT NULL,
  chunks INTEGER NOT NULL,
  post TEXT NOT NULL,
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL,
  complete INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX books_writer ON books(writer);
CREATE INDEX books_expires ON books(expires);

CREATE TABLE chunks (
  book TEXT NOT NULL,
  n INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (book, n)
);

-- each reader's notes on a book, sealed; replaced whole each time they send
CREATE TABLE notes (
  book TEXT NOT NULL,
  reader TEXT NOT NULL,
  data BLOB NOT NULL,
  size INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  PRIMARY KEY (book, reader)
);

-- what was done each day (UTC), against the daily caps
CREATE TABLE counts (
  day TEXT NOT NULL,
  what TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (day, what)
);
