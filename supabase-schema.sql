-- Create intakesessions table
CREATE TABLE IF NOT EXISTS intakesessions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  callid TEXT UNIQUE NOT NULL,
  patient_name TEXT,
  patient_age INTEGER,
  phonenumber TEXT,
  audio_path TEXT, -- storage file path for audio
  transcript JSONB,
  duration INTEGER,
  createdat TIMESTAMPTZ DEFAULT NOW()
);

-- Create soapnotes table
CREATE TABLE IF NOT EXISTS soapnotes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  sessionid UUID REFERENCES intakesessions(id) ON DELETE CASCADE,
  subjective TEXT,
  objective TEXT,
  assessment TEXT,
  plan TEXT,
  pdf_url TEXT, -- storage path or URL of generated PDF document
  createdat TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_intakesessions_callid ON intakesessions(callid);
CREATE INDEX IF NOT EXISTS idx_soapnotes_sessionid ON soapnotes(sessionid);