const express = require("express");
const cors = require("cors");
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const axios = require("axios");
const path = require("path");

const app = express();

// CORS configuration - MUST come first
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Body parsing middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.text());

// Serve static files
app.use(express.static("public"));

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Vapi configuration
const VAPI_API_KEY = process.env.VAPI_API_KEY;
const VAPI_ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID;
const VAPI_PHONE_NUMBER_ID = process.env.VAPI_PHONE_NUMBER_ID;
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
    console.log('Downloading file from:', url);
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 30000
    });
    console.log('File downloaded successfully, size:', response.data.length);
    return Buffer.from(response.data);
  } catch (error) {
    console.error('Error downloading file:', error.message);
    return null;
  }
}

// Store PDF in Supabase bucket
async function storePdfInBucket(pdfUrl, callId) {
  try {
    console.log('Storing PDF from URL:', pdfUrl);
    const pdfBuffer = await downloadFile(pdfUrl);
    if (!pdfBuffer) {
      throw new Error('Failed to download PDF');
    }

    const fileName = `vapi_soaps/call_${callId}_${Date.now()}.pdf`;
    
    const { data, error } = await supabase.storage
      .from("verde-health-bucket")
      .upload(fileName, pdfBuffer, {
        contentType: 'application/pdf',
        upsert: true
      });

    if (error) throw error;

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
    console.log('Storing recording from URL:', recordingUrl);
    const recordingBuffer = await downloadFile(recordingUrl);
    if (!recordingBuffer) {
      throw new Error('Failed to download recording');
    }

    const fileName = `vapi_recordings/call_${callId}_${Date.now()}.mp3`;
    
    const { data, error } = await supabase.storage
      .from("verde-health-bucket")
      .upload(fileName, recordingBuffer, {
        contentType: 'audio/mpeg',
        upsert: true
      });

    if (error) throw error;

    console.log('Recording stored successfully:', fileName);
    return fileName;
  } catch (error) {
    console.error('Error storing recording:', error);
    return null;
  }
}

// Handle OPTIONS requests for CORS preflight
app.options('/api/vapi/webhook', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.status(200).send();
});

// API: Vapi Webhook Handler - NO AUTHENTICATION REQUIRED
app.post("/api/vapi/webhook", async (req, res) => {
  try {
    // Log everything for debugging
    console.log('===========================================');
    console.log('VAPI WEBHOOK RECEIVED AT:', new Date().toISOString());
    console.log('Headers:', JSON.stringify(req.headers, null, 2));
    console.log('Body:', JSON.stringify(req.body, null, 2));
    console.log('===========================================');

    // Immediately respond to Vapi to avoid timeout
    res.status(200).json({ received: true, timestamp: new Date().toISOString() });

    // Process webhook asynchronously
    const { message } = req.body;
    
    if (!message) {
      console.log('No message object in webhook payload');
      return;
    }

    const { type, call, transcript, analysis, recordingUrl, endedReason, summary } = message;
    
    console.log('Webhook type:', type);
    console.log('Call ID:', call?.id);

    // Handle different webhook types
    if (type === 'end-of-call-report') {
      console.log('Processing end-of-call-report');
      
      if (!call || !call.id) {
        console.error('No call ID in end-of-call-report');
        return;
      }

      // Find the session by vapi_call_id
      const { data: sessions, error: findError } = await supabase
        .from("intakesessions")
        .select("*")
        .eq("vapi_call_id", call.id);

      console.log('Found sessions:', sessions?.length || 0);

      if (!sessions || sessions.length === 0) {
        // Try fallback - find most recent "calling" session
        console.log('Trying fallback to find session by status...');
        const { data: fallbackSessions } = await supabase
          .from("intakesessions")
          .select("*")
          .eq("status", "calling")
          .order("createdat", { ascending: false })
          .limit(1);

        if (fallbackSessions && fallbackSessions.length > 0) {
          console.log('Found session using fallback method');
          sessions.push(fallbackSessions[0]);
        } else {
          console.error('No session found for call:', call.id);
          return;
        }
      }

      const session = sessions[0];
      console.log('Processing session:', session.id);

      // Extract patient information
      const patientName = 
        summary?.patientName ||
        analysis?.patientName ||
        transcript?.[0]?.customer?.name ||
        call?.customer?.name ||
        "Patient Name Not Captured";

      const patientAge = 
        summary?.patientAge ||
        analysis?.patientAge ||
        null;

      console.log('Patient info - Name:', patientName, 'Age:', patientAge);

      // Process recording if available
      let recordingPath = null;
      if (recordingUrl) {
        console.log('Recording URL found:', recordingUrl);
        recordingPath = await storeRecordingInBucket(recordingUrl, call.id);
      }

      // Process SOAP PDF if available
      let pdfPath = null;
      const pdfUrl = 
        summary?.soapNotePdfUrl ||
        analysis?.soapNotePdfUrl ||
        call?.artifacts?.soapNotePdfUrl;

      if (pdfUrl) {
        console.log('SOAP PDF URL found:', pdfUrl);
        pdfPath = await storePdfInBucket(pdfUrl, call.id);
      }

      // Update the session with call results
      const { data: updateData, error: updateError } = await supabase
        .from("intakesessions")
        .update({
          patient_name: patientName,
          patient_age: patientAge ? parseInt(patientAge) : null,
          vapi_recording_url: recordingPath,
          transcript: transcript || null,
          duration: call?.duration || null,
          status: "completed",
          updatedat: new Date().toISOString()
        })
        .eq("id", session.id)
        .select();

      if (updateError) {
        console.error('Error updating session:', updateError);
      } else {
        console.log('Session updated successfully:', updateData);
      }

      // Create SOAP note if PDF was stored
      if (pdfPath) {
        const { data: soapData, error: soapError } = await supabase
          .from("soapnotes")
          .insert({
            sessionid: session.id,
            pdf_url: pdfPath,
            vapi_generated: true,
            vapi_metadata: {
              call_id: call.id,
              summary: summary || {},
              analysis: analysis || {}
            },
            createdat: new Date().toISOString()
          })
          .select();

        if (soapError) {
          console.error('Error creating SOAP note:', soapError);
        } else {
          console.log('SOAP note created successfully:', soapData);
        }
      }

      console.log('Call processing completed for:', call.id);
      
    } else if (type === 'status-update') {
      console.log('Status update:', message.status);
      
      if (message.status === 'ended' && call?.id) {
        // Update session status to show call ended
        await supabase
          .from("intakesessions")
          .update({
            status: "call-ended",
            updatedat: new Date().toISOString()
          })
          .eq("vapi_call_id", call.id);
      }
    } else {
      console.log('Unhandled webhook type:', type);
    }

  } catch (error) {
    console.error('Error processing webhook:', error);
    // Don't re-throw - we already responded to Vapi
  }
});

// API: Initiate Vapi Call
app.post("/api/vapi/initiate-call", async (req, res) => {
  try {
    const { phoneNumber } = req.body;

    if (!phoneNumber) {
      return res.status(400).json({ error: "Phone number is required" });
    }

    // Format phone number with country code
    let formattedPhone = phoneNumber;
    if (!formattedPhone.startsWith('+')) {
      const cleaned = formattedPhone.replace(/\D/g, '');
      formattedPhone = '+1' + cleaned;
    }

    console.log('Initiating call to:', formattedPhone);

    // Create intake session first
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

    console.log('Session created:', session.id);

    // Trigger Vapi outbound call
    try {
      const vapiResponse = await axios.post(
        `${VAPI_BASE_URL}/call/phone`,
        {
          phoneNumberId: VAPI_PHONE_NUMBER_ID,
          assistantId: VAPI_ASSISTANT_ID,
          customer: {
            number: formattedPhone
          },
          metadata: {
            sessionId: session.id
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${VAPI_API_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );

      console.log('Vapi call initiated:', vapiResponse.data.id);

      // Update session with Vapi call ID
      await supabase
        .from("intakesessions")
        .update({
          vapi_call_id: vapiResponse.data.id,
          vapi_assistant_id: VAPI_ASSISTANT_ID
        })
        .eq("id", session.id);

      res.json({ 
        success: true, 
        callId: vapiResponse.data.id,
        sessionId: session.id,
        message: "Call initiated successfully" 
      });

    } catch (vapiError) {
      console.error("Vapi API error:", vapiError.response?.data || vapiError.message);
      
      // Update session to failed
      await supabase
        .from("intakesessions")
        .update({ status: "failed" })
        .eq("id", session.id);

      res.status(500).json({ 
        error: vapiError.response?.data?.message || "Failed to initiate call" 
      });
    }

  } catch (error) {
    console.error("Error in initiate-call:", error);
    res.status(500).json({ error: error.message });
  }
});

// API: Get call status
app.get("/api/vapi/call-status/:callId", async (req, res) => {
  try {
    const { callId } = req.params;

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
    const { data: sessions, error: sessionsError } = await supabase
      .from("intakesessions")
      .select("*")
      .order("createdat", { ascending: false });

    if (sessionsError) {
      console.error("Error fetching sessions:", sessionsError);
      return res.status(500).json({ error: sessionsError.message });
    }

    const sessionsWithSoap = await Promise.all(
      sessions.map(async (session) => {
        const { data: soapNotes } = await supabase
          .from("soapnotes")
          .select("*")
          .eq("sessionid", session.id)
          .single();

        let pdfUrl = null;
        let recordingUrl = null;

        if (soapNotes?.pdf_url) {
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
    console.error("Error in /api/sessions:", error);
    res.status(500).json({ error: error.message });
  }
});

// API: Get SOAP PDF URL
app.get("/api/soap/pdf/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { data: soapNote, error } = await supabase
      .from("soapnotes")
      .select("*")
      .eq("id", id)
      .single();

    if (error || !soapNote) {
      return res.status(404).json({ error: "SOAP note not found" });
    }

    if (soapNote.pdf_url) {
      const { data: signedUrl, error: urlError } = await supabase.storage
        .from("verde-health-bucket")
        .createSignedUrl(soapNote.pdf_url, 3600);

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

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({ 
    status: "healthy", 
    timestamp: new Date().toISOString(),
    service: "Verde Health API with Vapi Integration",
    vapi: {
      configured: !!VAPI_API_KEY,
      assistantId: !!VAPI_ASSISTANT_ID,
      phoneNumberId: !!VAPI_PHONE_NUMBER_ID
    }
  });
});

// Test endpoint
app.post("/api/test-webhook", (req, res) => {
  console.log('TEST WEBHOOK - Headers:', req.headers);
  console.log('TEST WEBHOOK - Body:', req.body);
  res.json({ received: true, test: true });
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
  
  if (!VAPI_API_KEY || !VAPI_ASSISTANT_ID || !VAPI_PHONE_NUMBER_ID) {
    console.warn('⚠️  Warning: Vapi credentials not fully configured');
  }
});