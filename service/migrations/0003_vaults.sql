-- A writer's vault: their shares (each book's link id and key) sealed with a key from
-- their passkey (WebAuthn PRF), one per passkey, so signing in on another device with
-- the same (synced) passkey opens the same shares. The service cannot open it.
ALTER TABLE sessions ADD COLUMN credential TEXT;
CREATE TABLE vaults (
  credential TEXT PRIMARY KEY,
  writer TEXT NOT NULL,
  data BLOB NOT NULL,
  size INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX vaults_writer ON vaults(writer);
