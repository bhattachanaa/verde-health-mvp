// server.js - Verde Health MVP Backend (Vercel-Ready)

const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.')); // Serve static files including test-client.html

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Store active calls in memory (for MVP)
const activeCalls = new Map();

// Vapi webhook endpoint - this receives all call events
app.post('/api/webhooks/vapi', async (req, res) => {
  console.log('Vapi Event:', req.body.message?.type || 'unknown');
  console.log('Full webhook data:', JSON.stringify(req.body, null, 2));
  
  // Vapi sends data wrapped in a "message" object
  const message = req.body.message || req.body;
  const { type, call, transcript, messages } = message;
  
  try {
    switch(type) {
      case 'call-started':
        // Store call info when started
        activeCalls.set(call.id, {
          callId: call.id,
          phoneNumber: call.customer?.number || 'Unknown',
          startTime: new Date(),
          messages: []
        });
        console.log(`Call started: ${call.id}`);
        break;
        
      case 'transcript':
        // Store each message as it comes in
        if (activeCalls.has(call.id)) {
          const callData = activeCalls.get(call.id);
          callData.messages.push({
            role: transcript.role,
            content: transcript.transcript,
            timestamp: new Date()
          });
          activeCalls.set(call.id, callData);
        }
        break;
        
      case 'call-ended':
      case 'end-of-call-report':
        // Process the complete call and generate SOAP note
        const callId = call?.id || message.call?.id;
        const callMessages = messages || message.messages || message.artifact?.messages;
        const phoneNumber = message.customer?.number || call?.customer?.number || 'Unknown';
        const duration = message.durationSeconds || call?.duration;
        
        if (callId && callMessages && callMessages.length > 0) {
          // Generate SOAP note from conversation
          const soapNote = generateSOAPNote(callMessages);
          
          // Store in Supabase
          const { data: session, error: sessionError } = await supabase
            .from('intake_sessions')
            .insert({
              call_id: callId,
              phone_number: phoneNumber,
              transcript: callMessages,
              duration: duration,
              created_at: new Date()
            })
            .select()
            .single();
            
          if (sessionError) {
            console.error('Error storing session:', sessionError);
          } else if (session) {
            // Store SOAP note
            const { data: soap, error: soapError } = await supabase
              .from('soap_notes')
              .insert({
                session_id: session.id,
                subjective: soapNote.subjective,
                objective: soapNote.objective,
                assessment: soapNote.assessment,
                plan: soapNote.plan,
                created_at: new Date()
              })
              .select()
              .single();
              
            if (soapError) {
              console.error('Error storing SOAP note:', soapError);
            } else {
              console.log('✅ SOAP Note Generated and Stored:', soap);
            }
          }
          
          // Clean up if in activeCalls
          if (callId && activeCalls.has(callId)) {
            activeCalls.delete(callId);
          }
        }
        break;
    }
    
    res.status(200).json({ received: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Function to generate SOAP note from conversation
function generateSOAPNote(messages) {
  // Combine all messages into conversation text
  const conversation = messages
    .map(m => `${m.role}: ${m.content || m.transcript || m.text || m.message}`)
    .join('\n');
  
  // Extract information for SOAP format
  const extractedInfo = extractMedicalInfo(conversation);
  
  return {
    subjective: extractedInfo.subjective,
    objective: extractedInfo.objective,
    assessment: extractedInfo.assessment,
    plan: extractedInfo.plan
  };
}

// Extract medical information from conversation
function extractMedicalInfo(conversation) {
  const info = {
    subjective: '',
    objective: '',
    assessment: '',
    plan: ''
  };
  
  // Parse conversation for key information
  const lines = conversation.toLowerCase().split('\n');
  
  // Build Subjective section
  const subjectiveItems = [];
  
  // Find chief complaint
  const complaintPattern = /(?:brings you in|main concern|problem|issue|experiencing|feeling|symptoms?)[\s:]+([^.?\n]+)/i;
  const complaintMatch = conversation.match(complaintPattern);
  if (complaintMatch) {
    subjectiveItems.push(`Chief Complaint: ${complaintMatch[1].trim()}`);
  }
  
  // Find duration
  const durationPattern = /(?:started|began|how long|since when|duration)[\s:]+([^.?\n]+)/i;
  const durationMatch = conversation.match(durationPattern);
  if (durationMatch) {
    subjectiveItems.push(`Duration: ${durationMatch[1].trim()}`);
  }
  
  // Find pain scale
  const painPattern = /(?:pain.*?|discomfort.*?)(\d+)\s*(?:out of 10|\/10)/i;
  const painMatch = conversation.match(painPattern);
  if (painMatch) {
    subjectiveItems.push(`Pain Level: ${painMatch[1]}/10`);
  }
  
  // Find medications
  const medicationPattern = /(?:medications?|taking|prescribed)[\s:]+([^.?\n]+)/i;
  const medicationMatch = conversation.match(medicationPattern);
  if (medicationMatch) {
    subjectiveItems.push(`Current Medications: ${medicationMatch[1].trim()}`);
  }
  
  // Find allergies
  const allergyPattern = /(?:allergies?|allergic)[\s:]+([^.?\n]+)/i;
  const allergyMatch = conversation.match(allergyPattern);
  if (allergyMatch) {
    subjectiveItems.push(`Allergies: ${allergyMatch[1].trim()}`);
  }
  
  // Find symptoms
  const symptomKeywords = ['fever', 'cough', 'headache', 'nausea', 'vomiting', 'dizziness', 'fatigue', 'chills', 'sweating', 'ankle', 'swelling'];
  const foundSymptoms = symptomKeywords.filter(symptom => conversation.toLowerCase().includes(symptom));
  if (foundSymptoms.length > 0) {
    subjectiveItems.push(`Associated Symptoms: ${foundSymptoms.join(', ')}`);
  }
  
  // Extract patient name if present
  const namePattern = /(?:my name is|i am|i'm)\s+([a-zA-Z\s]+?)(?:\.|,|\n|$)/i;
  const nameMatch = conversation.match(namePattern);
  if (nameMatch) {
    subjectiveItems.unshift(`Patient Name: ${nameMatch[1].trim()}`);
  }
  
  // Extract DOB if present
  const dobPattern = /(?:born|birth|dob)[\s:]+([^.?\n]+)/i;
  const dobMatch = conversation.match(dobPattern);
  if (dobMatch) {
    subjectiveItems.push(`Date of Birth: ${dobMatch[1].trim()}`);
  }
  
  info.subjective = subjectiveItems.join('\n') || 'Patient intake information recorded via phone assessment.';
  
  // Build Objective section (limited for phone intake)
  info.objective = 'Phone assessment - vital signs and physical examination pending in-person evaluation.\n' +
                   'Patient alert and oriented based on phone conversation.\n' +
                   'Speech clear and coherent.';
  
  // Build Assessment section
  const assessmentItems = [];
  
  // Basic differential based on symptoms
  if (conversation.includes('chest pain')) {
    assessmentItems.push('Differential includes: cardiac etiology, GERD, musculoskeletal pain, anxiety');
  }
  if (conversation.includes('headache')) {
    assessmentItems.push('Differential includes: tension headache, migraine, sinusitis');
  }
  if (conversation.includes('cough') || conversation.includes('fever')) {
    assessmentItems.push('Differential includes: upper respiratory infection, influenza, COVID-19');
  }
  if (conversation.includes('ankle') || conversation.includes('swelling')) {
    assessmentItems.push('Differential includes: ankle sprain, tendinitis, fracture (requires imaging), venous insufficiency');
  }
  
  info.assessment = assessmentItems.join('\n') || 'Assessment pending physical examination and review of symptoms.';
  
  // Build Plan section
  info.plan = 'Patient scheduled for in-person evaluation.\n' +
              'Will obtain vital signs and perform physical examination.\n' +
              'Consider diagnostic testing based on examination findings.\n' +
              'Patient advised to proceed to emergency department if symptoms worsen.';
  
  return info;
}

// Endpoint to start a call via Vapi
app.post('/api/calls/start', async (req, res) => {
  const { phoneNumber } = req.body;
  
  try {
    // Make call using Vapi API
    const axios = require('axios');
    const response = await axios.post(
      'https://api.vapi.ai/call',
      {
        assistantId: process.env.VAPI_ASSISTANT_ID,
        customer: {
          number: phoneNumber
        },
        phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.VAPI_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log('Call started:', response.data);
    
    res.json({ 
      message: 'Call initiated successfully',
      phoneNumber,
      callId: response.data.id,
      status: response.data.status
    });
  } catch (error) {
    console.error('Error starting call:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Failed to start call',
      details: error.response?.data || error.message 
    });
  }
});

// Get SOAP note by call ID
app.get('/api/soap/:callId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('soap_notes')
      .select(`
        *,
        intake_sessions!inner(call_id, phone_number, created_at)
      `)
      .eq('intake_sessions.call_id', req.params.callId)
      .single();
    
    if (error) throw error;
    
    res.json(data);
  } catch (error) {
    res.status(404).json({ error: 'SOAP note not found' });
  }
});

// Get all SOAP notes (for dashboard)
app.get('/api/soap', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('soap_notes')
      .select(`
        *,
        intake_sessions(call_id, phone_number, created_at)
      `)
      .order('created_at', { ascending: false })
      .limit(10);
    
    if (error) {
      console.error('Supabase error:', error);
      return res.status(500).json({ error: error.message });
    }
    
    res.json(data || []);
  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3001;

// For Vercel deployment
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Verde Health Backend running on port ${PORT}`);
    console.log(`Webhook endpoint: http://localhost:${PORT}/api/webhooks/vapi`);
    
    // Test Supabase connection on startup
    supabase.from('intake_sessions').select('count').single()
      .then(() => console.log('✅ Supabase connected successfully'))
      .catch(err => console.error('❌ Supabase connection error:', err.message));
  });
}

// Export for Vercel
module.exports = app;