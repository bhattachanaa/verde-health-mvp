const express = require("express");
const cors = require("cors");
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const axios = require("axios");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Vapi configuration
const VAPI_API_KEY = process.env.VAPI_API_KEY;
const VAPI_ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID;
const VAPI_BASE_URL = 'https://api.vapi.ai';

// Helper function to generate unique IDs
function generateUniqueId(prefix = "ID") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Helper function to format phone numbers
function formatPhoneNumber(phone) {
  const cleaned = phone?.replace(/\D/g, "") || "";
  if (cleaned.length === 10) {
    return `(${cleaned.slice(0, 3)}) ${cleaned.slice(3, 6)}-${cleaned.slice(6)}`;
  }
  return phone;
}

// Download file from URL
async function downloadFile(url) {
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer'
    });
    return Buffer.from(response.data);
  } catch (error) {
    console.error('Error downloading file:', error);
    return null;
  }
}

// Store PDF in Supabase bucket
async function storePdfInBucket(pdfUrl, callId) {
  try {
    // Download PDF from Vapi
    const pdfBuffer = await downloadFile(pdfUrl);
    if (!pdfBuffer) {
      throw new Error('Failed to download PDF');
    }

    // Generate file path
    const fileName = `vapi_soaps/call_${callId}_${Date.now()}.pdf`;
    
    // Upload to Supabase storage
    const { data, error } = await supabase.storage
      .from("verde-health-bucket")
      .upload(fileName, pdfBuffer, {
        contentType: 'application/pdf',
        upsert: true
      });

    if (error) {
      throw error;
    }

    console.log('PDF stored successfully:', fileName);
    return fileName;
  } catch (error) {
    console.error('Error storing PDF:', error);
    return null;
  }
}

// Store recording in Supabase bucket
async function storeRecordingInBucket(recordingUrl, callId) {
  try {
    // Download recording from Vapi
    const recordingBuffer = await downloadFile(recordingUrl);
    if (!recordingBuffer) {
      throw new Error('Failed to download recording');
    }

    // Generate file path
    const fileName = `vapi_recordings/call_${callId}_${Date.now()}.mp3`;
    
    // Upload to Supabase storage
    const { data, error } = await supabase.storage
      .from("verde-health-bucket")
      .upload(fileName, recordingBuffer, {
        contentType: 'audio/mpeg',
        upsert: true
      });

    if (error) {
      throw error;
    }

    console.log('Recording stored successfully:', fileName);
    return fileName;
  } catch (error) {
    console.error('Error storing recording:', error);
    return null;
  }
}

// API: Initiate Vapi Call
app.post("/api/vapi/initiate-call", async (req, res) => {
  try {
    const { phoneNumber } = req.body;

    if (!phoneNumber) {
      return res.status(400).json({ error: "Phone number is required" });
    }

    // Create intake session in database first
    const { data: session, error: sessionError } = await supabase
      .from("intakesessions")
      .insert({
        callid: generateUniqueId("VAPI"),
        phonenumber: phoneNumber.replace(/\D/g, ""),
        status: "calling",
        createdat: new Date().toISOString()
      })
      .select()
      .single();

    if (sessionError) {
      console.error("Error creating session:", sessionError);
      return res.status(500).json({ error: "Failed to create session" });
    }

    // Trigger Vapi outbound call
    const vapiResponse = await axios.post(
      `${VAPI_BASE_URL}/call`,
      {
        assistantId: VAPI_ASSISTANT_ID,
        customer: {
          number: phoneNumber
        },
        assistantOverrides: {
          firstMessage: "Hello! This is Verde Health's AI assistant. I'm calling to help with your medical intake assessment. Is now a good time to talk?",
          model: {
            provider: "openai",
            model: "gpt-4",
            temperature: 0.7
          }
        },
        metadata: {
          sessionId: session.id,
          timestamp: new Date().toISOString()
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${VAPI_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    // Update session with Vapi call ID
    await supabase
      .from("intakesessions")
      .update({
        vapi_call_id: vapiResponse.data.id,
        vapi_assistant_id: VAPI_ASSISTANT_ID
      })
      .eq("id", session.id);

    console.log('Vapi call initiated:', vapiResponse.data.id);

    res.json({ 
      success: true, 
      callId: vapiResponse.data.id,
      sessionId: session.id,
      message: "Call initiated successfully" 
    });

  } catch (error) {
    console.error("Error initiating Vapi call:", error.response?.data || error.message);
    res.status(500).json({ 
      error: error.response?.data?.message || "Failed to initiate call" 
    });
  }
});

// API: Vapi Webhook Handler
app.post("/api/vapi/webhook", async (req, res) => {
  try {
    const { 
      type, 
      call,
      messages,
      recordingUrl,
      transcript,
      analysis,
      artifacts
    } = req.body;

    console.log('Vapi webhook received:', type);

    // Handle different webhook types
    switch (type) {
      case 'call.started':
        // Update session status
        if (call?.metadata?.sessionId) {
          await supabase
            .from("intakesessions")
            .update({
              status: "in-progress",
              vapi_call_id: call.id
            })
            .eq("id", call.metadata.sessionId);
        }
        break;

      case 'call.ended':
      case 'call-ended': // Handle both formats
        // Process completed call
        if (call?.metadata?.sessionId || call?.customerId) {
          // Find session by Vapi call ID
          const { data: sessions } = await supabase
            .from("intakesessions")
            .select("*")
            .eq("vapi_call_id", call.id)
            .single();

          const sessionId = sessions?.id || call.metadata?.sessionId;

          if (sessionId) {
            // Extract patient information from call analysis
            const patientName = analysis?.patientName || 
                              call.analysis?.patientName || 
                              "Unknown Patient";
            const patientAge = analysis?.patientAge || 
                             call.analysis?.patientAge || 
                             null;

            // Store recording if available
            let recordingPath = null;
            if (recordingUrl) {
              recordingPath = await storeRecordingInBucket(recordingUrl, call.id);
            }

            // Store SOAP PDF if available
            let pdfPath = null;
            if (artifacts?.soapNotePdfUrl) {
              pdfPath = await storePdfInBucket(artifacts.soapNotePdfUrl, call.id);
            } else if (analysis?.soapPdfUrl) {
              pdfPath = await storePdfInBucket(analysis.soapPdfUrl, call.id);
            }

            // Update intake session
            const { error: updateError } = await supabase
              .from("intakesessions")
              .update({
                patient_name: patientName,
                patient_age: patientAge ? parseInt(patientAge) : null,
                vapi_recording_url: recordingPath,
                transcript: transcript || messages || null,
                duration: call.duration || null,
                status: "completed",
                updatedat: new Date().toISOString()
              })
              .eq("id", sessionId);

            if (updateError) {
              console.error("Error updating session:", updateError);
            }

            // Create SOAP note record if PDF was generated
            if (pdfPath) {
              const { error: soapError } = await supabase
                .from("soapnotes")
                .insert({
                  sessionid: sessionId,
                  pdf_url: pdfPath,
                  vapi_generated: true,
                  vapi_metadata: {
                    call_id: call.id,
                    analysis: analysis || call.analysis || {},
                    artifacts: artifacts || {}
                  },
                  createdat: new Date().toISOString()
                });

              if (soapError) {
                console.error("Error creating SOAP note:", soapError);
              }
            }

            console.log('Call completed and processed:', call.id);
          }
        }
        break;

      case 'call.failed':
      case 'call-failed':
        // Handle failed calls
        if (call?.metadata?.sessionId) {
          await supabase
            .from("intakesessions")
            .update({
              status: "failed",
              updatedat: new Date().toISOString()
            })
            .eq("id", call.metadata.sessionId);
        }
        break;

      case 'transcript':
      case 'transcript-complete':
        // Handle transcript updates
        if (call?.metadata?.sessionId && transcript) {
          await supabase
            .from("intakesessions")
            .update({
              transcript: transcript,
              updatedat: new Date().toISOString()
            })
            .eq("id", call.metadata.sessionId);
        }
        break;

      default:
        console.log('Unhandled webhook type:', type);
    }

    res.json({ received: true });

  } catch (error) {
    console.error("Error processing Vapi webhook:", error);
    res.status(500).json({ error: "Webhook processing failed" });
  }
});

// API: Get call status
app.get("/api/vapi/call-status/:callId", async (req, res) => {
  try {
    const { callId } = req.params;

    // Get session by Vapi call ID
    const { data: session, error } = await supabase
      .from("intakesessions")
      .select("*")
      .eq("vapi_call_id", callId)
      .single();

    if (error || !session) {
      return res.status(404).json({ error: "Session not found" });
    }

    res.json({
      status: session.status,
      sessionId: session.id,
      patientName: session.patient_name,
      completed: session.status === "completed"
    });

  } catch (error) {
    console.error("Error getting call status:", error);
    res.status(500).json({ error: "Failed to get call status" });
  }
});

// API: Get all sessions with SOAP notes
app.get("/api/sessions", async (req, res) => {
  try {
    // Get all intake sessions
    const { data: sessions, error: sessionsError } = await supabase
      .from("intakesessions")
      .select("*")
      .order("createdat", { ascending: false });

    if (sessionsError) {
      console.error("Error fetching sessions:", sessionsError);
      return res.status(500).json({ error: sessionsError.message });
    }

    // Get SOAP notes for each session
    const sessionsWithSoap = await Promise.all(
      sessions.map(async (session) => {
        // Get SOAP notes for this session
        const { data: soapNotes, error: soapError } = await supabase
          .from("soapnotes")
          .select("*")
          .eq("sessionid", session.id)
          .single();

        if (soapError && soapError.code !== "PGRST116") {
          console.error("SOAP notes query error:", soapError);
        }

        // Generate public URLs for files
        let pdfUrl = null;
        let recordingUrl = null;

        if (soapNotes && soapNotes.pdf_url) {
          const { data: pdfData } = supabase.storage
            .from("verde-health-bucket")
            .getPublicUrl(soapNotes.pdf_url);
          
          pdfUrl = pdfData?.publicUrl;
        }

        if (session.vapi_recording_url) {
          const { data: recordingData } = supabase.storage
            .from("verde-health-bucket")
            .getPublicUrl(session.vapi_recording_url);
          
          recordingUrl = recordingData?.publicUrl;
        }

        return {
          ...session,
          soapnotes: soapNotes ? {
            ...soapNotes,
            pdf_url: pdfUrl
          } : null,
          vapi_recording_url: recordingUrl
        };
      })
    );

    res.json(sessionsWithSoap);

  } catch (error) {
    console.error("Unexpected error in /api/sessions:", error);
    res.status(500).json({ error: error.message });
  }
});

// API: Get SOAP PDF URL
app.get("/api/soap/pdf/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // Get SOAP note
    const { data: soapNote, error } = await supabase
      .from("soapnotes")
      .select("*")
      .eq("id", id)
      .single();

    if (error || !soapNote) {
      return res.status(404).json({ error: "SOAP note not found" });
    }

    // Generate signed URL for PDF
    if (soapNote.pdf_url) {
      const { data: signedUrl, error: urlError } = await supabase.storage
        .from("verde-health-bucket")
        .createSignedUrl(soapNote.pdf_url, 3600); // 1 hour expiry

      if (!urlError && signedUrl) {
        res.json({ 
          url: signedUrl.signedUrl,
          metadata: soapNote.vapi_metadata 
        });
      } else {
        throw new Error("Failed to generate signed URL");
      }
    } else {
      res.status(404).json({ error: "PDF not available" });
    }

  } catch (error) {
    console.error("Error getting SOAP PDF:", error);
    res.status(500).json({ error: "Failed to retrieve PDF" });
  }
});

// API: Get recording URL
app.get("/api/recording/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;

    // Get session
    const { data: session, error } = await supabase
      .from("intakesessions")
      .select("vapi_recording_url")
      .eq("id", sessionId)
      .single();

    if (error || !session || !session.vapi_recording_url) {
      return res.status(404).json({ error: "Recording not found" });
    }

    // Generate signed URL for recording
    const { data: signedUrl, error: urlError } = await supabase.storage
      .from("verde-health-bucket")
      .createSignedUrl(session.vapi_recording_url, 3600); // 1 hour expiry

    if (!urlError && signedUrl) {
      res.json({ url: signedUrl.signedUrl });
    } else {
      throw new Error("Failed to generate signed URL");
    }

  } catch (error) {
    console.error("Error getting recording:", error);
    res.status(500).json({ error: "Failed to retrieve recording" });
  }
});

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({ 
    status: "healthy", 
    timestamp: new Date().toISOString(),
    service: "Verde Health API with Vapi Integration",
    vapi: {
      configured: !!VAPI_API_KEY,
      assistantId: !!VAPI_ASSISTANT_ID
    }
  });
});

// Serve the main HTML file for all other routes
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🌿 Verde Health server running on port ${PORT}`);
  console.log(`📞 Vapi integration: ${VAPI_API_KEY ? 'Connected' : 'Not configured'}`);
  console.log(`🔗 Visit http://localhost:${PORT} to access the application`);
  
  if (!VAPI_API_KEY || !VAPI_ASSISTANT_ID) {
    console.warn('⚠️  Warning: Vapi credentials not configured. Please set VAPI_API_KEY and VAPI_ASSISTANT_ID in .env');
  }
});