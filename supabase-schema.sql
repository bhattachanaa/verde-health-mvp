-- Create intake_sessions table
CREATE TABLE intake_sessions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  call_id TEXT UNIQUE NOT NULL,
  phone_number TEXT,
  transcript JSONB,
  duration INTEGER,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create SOAP notes table
CREATE TABLE soap_notes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id UUID REFERENCES intake_sessions(id) ON DELETE CASCADE,
  subjective TEXT,
  objective TEXT,
  assessment TEXT,
  plan TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX idx_intake_sessions_call_id ON intake_sessions(call_id);
CREATE INDEX idx_soap_notes_session_id ON soap_notes(session_id);
