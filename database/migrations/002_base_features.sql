ALTER TABLE app.profiles ADD COLUMN IF NOT EXISTS display_name text NOT NULL DEFAULT '';
ALTER TABLE app.children ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false;
ALTER TABLE app.activities ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 1;
ALTER TABLE app.corrections ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES app.profiles;
ALTER TABLE app.corrections ADD COLUMN IF NOT EXISTS review_note text;
CREATE TABLE IF NOT EXISTS app.content(slug text PRIMARY KEY,title text NOT NULL,body text NOT NULL,published boolean NOT NULL DEFAULT false,version int NOT NULL DEFAULT 1,updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS app.support(id uuid PRIMARY KEY,owner_id uuid NOT NULL REFERENCES app.profiles,topic text NOT NULL,message text NOT NULL,status text NOT NULL DEFAULT 'open' CHECK(status IN('open','in_progress','resolved')),reply text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS app.deletion_requests(owner_id uuid PRIMARY KEY REFERENCES app.profiles,status text NOT NULL DEFAULT 'pending',created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS support_queue ON app.support(status,created_at);
