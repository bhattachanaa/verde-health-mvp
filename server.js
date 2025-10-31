const express = require("express");
const cors = require("cors");
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public")); // Serve static frontend files

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// Helper to delete audio from Supabase Storage bucket after processing
async function deleteAudioFile(filePath) {
  const { data, error } = await supabase.storage
    .from("verde-health-bucket")
    .remove([filePath]);

  if (error) {
    console.error("Error deleting audio file:", error);
    return false;
  }
  return true;
}

// API: Get all intake sessions with patient info and SOAP note (including pdf_url)
app.get("/api/sessions", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("intakesessions")
      .select(`
        id,
        callid,
        phonenumber,
        patient_name,
        patient_age,
        audio_path,
        soapnotes (
          id,
          subjective,
          objective,
          assessment,
          plan,
          pdf_url
        )
      `)
      .order("createdat", { ascending: false });

    if (error) throw error;

    // Generate signed URLs for pdf and audio files if exists
    const signedData = await Promise.all(data.map(async (session) => {
      let pdfUrl = null;
      if (session.soapnotes && session.soapnotes.pdf_url) {
        const { signedURL, error: urlError } = await supabase.storage
          .from("verde-health-bucket")
          .createSignedUrl(session.soapnotes.pdf_url, 60 * 60);
        if (!urlError) pdfUrl = signedURL;
      }

      let audioUrl = null;
      if (session.audio_path) {
        const { signedURL, error: audioError } = await supabase.storage
          .from("verde-health-bucket")
          .createSignedUrl(session.audio_path, 60 * 60);
        if (!audioError) audioUrl = signedURL;
      }

      return {
        ...session,
        soapnotes: session.soapnotes ? { ...session.soapnotes, pdf_url: pdfUrl } : null,
        audio_url: audioUrl,
      };
    }));

    res.json(signedData);

  } catch (error) {
    console.error("Error fetching sessions:", error);
    res.status(500).json({ error: error.message });
  }
});

// Optional: API to preview SOAP note document (could be HTML or PDF stream)
app.get("/api/soap/preview/:id", async (req, res) => {
  try {
    const soapId = req.params.id;
    const { data, error } = await supabase
      .from("soapnotes")
      .select("*")
      .eq("id", soapId)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: "SOAP note not found" });
    }

    // You can choose to return structured JSON or serve a PDF from storage
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Example webhook or process where audio is handled & deleted
app.post("/api/process-audio", async (req, res) => {
  // Assume req.body contains session info & audio file path
  const { sessionId, audioPath } = req.body;

  // Process audio to extract data and save SOAP note (not implemented here)
  // ...

  // After successful storage of info, delete audio from bucket
  const deleted = await deleteAudioFile(audioPath);
  if (!deleted) {
    console.warn("Audio file deletion failed or was not found");
  }

  res.json({ status: "Processed and cleaned audio file" });
});

// Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
