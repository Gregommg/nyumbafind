CREATE TABLE IF NOT EXISTS users(
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, phone TEXT,
  password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('tenant','landlord','admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS listings(
  id SERIAL PRIMARY KEY, owner_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL, area TEXT NOT NULL, type TEXT NOT NULL, price INT NOT NULL CHECK (price > 0),
  phone TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', features TEXT[] NOT NULL DEFAULT '{}',
  lat DOUBLE PRECISION NOT NULL, lng DOUBLE PRECISION NOT NULL, vacant BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS listings_area_idx ON listings(area);
CREATE INDEX IF NOT EXISTS listings_price_idx ON listings(price);
CREATE TABLE IF NOT EXISTS listing_images(
  id SERIAL PRIMARY KEY, listing_id INT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  url TEXT NOT NULL, public_id TEXT NOT NULL, position INT NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS favorites(
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id INT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, listing_id));
CREATE TABLE IF NOT EXISTS requests(
  id SERIAL PRIMARY KEY, phone TEXT NOT NULL, area TEXT, type TEXT, budget INT, county TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
ALTER TABLE requests ADD COLUMN IF NOT EXISTS county TEXT;
CREATE TABLE IF NOT EXISTS messages(
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS banner_photos(
  id SERIAL PRIMARY KEY, url TEXT NOT NULL, public_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'exterior', created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS search_events(
  id BIGSERIAL PRIMARY KEY, county TEXT NOT NULL, area TEXT, type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS search_events_created_idx ON search_events(created_at);
CREATE INDEX IF NOT EXISTS search_events_county_area_idx ON search_events(county, area);
CREATE TABLE IF NOT EXISTS api_request_metrics(
  id BIGSERIAL PRIMARY KEY, method TEXT NOT NULL, path TEXT NOT NULL,
  status INT NOT NULL, duration_ms DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS api_request_metrics_created_idx ON api_request_metrics(created_at);
CREATE TABLE IF NOT EXISTS featured_areas(
  county TEXT PRIMARY KEY, areas TEXT[] NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now());

-- ===== Payments, boosts, access and bookings =====
ALTER TABLE users ADD COLUMN IF NOT EXISTS view_credits INT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS suggest_until TIMESTAMPTZ;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'rent';
ALTER TABLE listings ADD COLUMN IF NOT EXISTS max_guests INT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS instant_book BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS pinned_until TIMESTAMPTZ;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS badge_until TIMESTAMPTZ;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS home_until TIMESTAMPTZ;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS popular_until TIMESTAMPTZ;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS user_id INT REFERENCES users(id) ON DELETE SET NULL;
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS products(
  id SERIAL PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('view_pack','boost','suggest_sub')),
  role TEXT NOT NULL CHECK (role IN ('tenant','landlord')), name TEXT NOT NULL,
  price INT NOT NULL CHECK (price > 0), qty INT NOT NULL CHECK (qty > 0),
  pin BOOLEAN NOT NULL DEFAULT FALSE, badge BOOLEAN NOT NULL DEFAULT FALSE,
  home BOOLEAN NOT NULL DEFAULT FALSE, popular BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS payments(
  id SERIAL PRIMARY KEY, ref TEXT UNIQUE NOT NULL, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product JSONB NOT NULL, listing_id INT, amount INT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  tracking_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), paid_at TIMESTAMPTZ);
CREATE INDEX IF NOT EXISTS payments_user_idx ON payments(user_id);
CREATE TABLE IF NOT EXISTS unlocks(
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id INT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (user_id, listing_id));
CREATE TABLE IF NOT EXISTS bookings(
  id SERIAL PRIMARY KEY, listing_id INT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  guest_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  check_in DATE NOT NULL, check_out DATE NOT NULL, guests INT NOT NULL DEFAULT 1,
  nights INT NOT NULL, total INT NOT NULL, note TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','declined','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS bookings_listing_idx ON bookings(listing_id, status);
CREATE INDEX IF NOT EXISTS bookings_guest_idx ON bookings(guest_id);
