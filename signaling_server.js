// signaling_server.js (Group + AI Mod/Kick + User Flag->AI Kick/Remove + AI Chat + Inactivity)
const WebSocket = require('ws');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const { v4: uuidv4 } = require('uuid'); // Use UUIDs for message IDs

// --- Configuration ---
const PORT = process.env.PORT || 8080;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MAX_HISTORY_LENGTH = 20; // Keep history reasonable
const AI_MODEL_NAME = "gemini-1.5-flash-latest";
const INACTIVITY_TIMEOUT = 60 * 1000; // 60 seconds
const ACTIVITY_CHECK_INTERVAL = 30 * 1000; // Check every 30 seconds
const CENSOR_REPLACEMENT = "****";
const profanityBlacklist = new Set([ // Basic list, add more as needed (lowercase)
    "fuck", "fucking", "fucked", "shit", "shitty", "asshole", "bitch", "cunt"
]);

// --- Validate API Key ---
if (!GEMINI_API_KEY) { console.error("FATAL ERROR: GEMINI_API_KEY environment variable is not set."); process.exit(1); }

// --- Initialize AI Client ---
let genAI, aiModel;
try {
    genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    aiModel = genAI.getGenerativeModel({ model: AI_MODEL_NAME });
    console.log(`Initialized Google AI: ${AI_MODEL_NAME}`);
} catch (error) { console.error("FATAL ERROR: AI client init failed.", error); process.exit(1); }

// Safety settings for moderation (stricter) and flag confirmation
const moderationSafetySettings = [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT,        threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,       threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
];
// Safety settings for AI *generation*
const generationSafetySettings = [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT,        threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,       threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
];

// --- WebSocket Server Setup ---
const wss = new WebSocket.Server({ port: PORT });
console.log(`Chat Relay Server started on port ${PORT}`);

// --- Server State ---
let peers = {};         // { peerId: { ws, topic, isAlive, lastActivity }, ... }
let rooms = {};         // { topic: Set<peerId>, ... }
let roomHistories = {}; // { topic: [{ msgId, senderId, role, parts, timestamp, status }] } // status = 'safe', 'flag_confirmed', 'removed'
let flaggedMessages = {}; // { topic: { msgId: { flaggedBy, originalSender, text, status } } } // status = 'pending_ai', 'ai_safe', 'ai_unsafe'

// --- Helper Functions ---
function generateId() { return Math.random().toString(36).substring(2, 10); }
function generateMessageId() { return uuidv4(); }
function safeSend(ws, data) { try { if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(data)); return true; } else { return false; } } catch (error) { console.error("safeSend Error:", error); return false; } }
function broadcastToRoom(topic, messageData, senderId) { if (!rooms[topic]) return; rooms[topic].forEach(peerId => { if (peerId !== senderId && peers[peerId]) { safeSend(peers[peerId].ws, messageData); } }); }
function notifyRoomUpdate(topic, reason = "update") { if (!rooms[topic]) return; const currentPeers = Array.from(rooms[topic]); let genericReason = reason; if (reason.startsWith('peer_joined:')) genericReason = 'peer_joined'; if (reason.startsWith('peer_left:')) genericReason = 'peer_left'; const updateMessage = { type: 'room_update', topic: topic, peers: currentPeers, reason: genericReason }; currentPeers.forEach(peerId => { if (peers[peerId]) { safeSend(peers[peerId].ws, updateMessage); } }); console.log(`Room update: ${topic}. Reason: ${genericReason}. Peers: ${currentPeers.length}`); }

function cleanupPeer(peerId, reasonCode = 1000, reasonMsg = "Cleanup called") {
    console.log(`Cleaning up peer: ${peerId}. Reason: ${reasonMsg}`);
    const peerData = peers[peerId]; if (!peerData) { return; }
    const topic = peerData.topic;
    if (topic && rooms[topic]) {
        const wasInRoom = rooms[topic].delete(peerId);
        if (wasInRoom) {
             console.log(`Removed ${peerId} from room ${topic}. Size: ${rooms[topic].size}`);
             if (rooms[topic].size === 0) { console.log(`Deleting empty room: ${topic}`); delete rooms[topic]; delete roomHistories[topic]; delete flaggedMessages[topic]; } // Clear all room data
             else { notifyRoomUpdate(topic, `peer_left`); }
              // Clean up flags made *by* this user if flag data exists for the topic
              if (flaggedMessages[topic]) {
                   Object.keys(flaggedMessages[topic]).forEach(msgId => {
                        if (flaggedMessages[topic][msgId]?.flaggedBy) {
                             flaggedMessages[topic][msgId].flaggedBy.delete(peerId);
                        }
                   });
              }
        }
    }
    delete peers[peerId]; console.log(`Peer ${peerId} removed. Total: ${Object.keys(peers).length}.`);
    if (peerData.ws && peerData.ws.readyState !== WebSocket.CLOSED && peerData.ws.readyState !== WebSocket.CLOSING) { peerData.ws.close(reasonCode, reasonMsg); }
}

function censorMessage(text) { // Censors basic profanity
    if (!text) return "";
    const words = text.split(/(\s+)/);
    const censoredWords = words.map(word => {
        const punctuation = word.match(/[.,!?;:]$/)?.[0] || "";
        const cleanWord = word.replace(/[.,!?;:]$/, '').toLowerCase();
        return profanityBlacklist.has(cleanWord) ? (CENSOR_REPLACEMENT + punctuation) : word;
    });
    return censoredWords.join("");
}

async function checkMessageSafety(messageText) { // Checks for harmful content via AI
    if (!messageText || messageText.trim().length === 0) return { safe: true, reason: "Empty" };
    try {
        const result = await aiModel.generateContent( messageText, { safetySettings: moderationSafetySettings } );
        const promptFeedback = result?.response?.promptFeedback; const blockReason = promptFeedback?.blockReason;
        if (blockReason && blockReason !== "BLOCK_REASON_UNSPECIFIED" && blockReason !== "OTHER") { console.warn(`Safety Check BLOCKED (Harmful): ${blockReason}`); return { safe: false, reason: blockReason }; }
        else { const highSeverityRating = promptFeedback?.safetyRatings?.find(r => r.probability === 'HIGH'); if(highSeverityRating) { console.warn(`Safety Check FLAGGED (Harmful): ${highSeverityRating.category}`); return { safe: false, reason: `Flagged: ${highSeverityRating.category}` }; } return { safe: true, reason: "Passed Harm Check" }; }
    } catch (error) { console.error("Safety check API error:", error); return { safe: false, reason: "API_Error" }; }
 }

async function getAIResponse(topic) { // Generates AI chat response
    if (!roomHistories[topic] || roomHistories[topic].length === 0) return "The conversation hasn't started yet.";
    console.log(`Requesting AI response for: ${topic}`);
    const safeHistory = roomHistories[topic].filter(m => m.status === 'safe' || m.role === 'model'); // Use safe user messages + AI messages
    if (safeHistory.length === 0) return "[Not enough safe conversation history yet.]"; // Check after filtering
    let formattedHistory = []; let lastRole = null; let currentParts = [];
    safeHistory.forEach((entry, index) => { const sanitizedParts = entry.parts.map(part => ({ text: (typeof part.text === 'string' ? part.text.substring(0, 1000) : "[invalid]") })); if (entry.role === lastRole) { currentParts.push(...sanitizedParts); } else { if (currentParts.length > 0 && lastRole) formattedHistory.push({ role: lastRole, parts: currentParts }); currentParts = sanitizedParts; lastRole = entry.role; } if (index === safeHistory.length - 1 && currentParts.length > 0) formattedHistory.push({ role: lastRole, parts: currentParts }); });
    const systemPrompt = `Observe the chat about "${topic}". Briefly comment on recent messages, offer insight, or ask a question. Concise (1-2 sentences).`; formattedHistory.unshift({ role: "user", parts: [{ text: systemPrompt }] }); if (formattedHistory.length > 1 && formattedHistory[0].role === 'model') formattedHistory.shift();
    if (formattedHistory.length === 0 || (formattedHistory.length === 1 && formattedHistory[0].role === 'user')) { return "[Not enough conversation yet for AI comment.]"; }
    try {
        const result = await aiModel.generateContent({ contents: formattedHistory, generationConfig: { temperature: 0.75, topP: 0.95, maxOutputTokens: 150 }, safetySettings: generationSafetySettings });
        if (result.response) { const text = result.response.text(); if (!text || text.trim().length === 0) { return "[AI had no comment.]"; } console.log(`AI Resp ${topic}: ${text.substring(0, 80)}...`); if (!roomHistories[topic]) roomHistories[topic] = []; roomHistories[topic].push({ role: "model", parts: [{ text: text }], msgId: generateMessageId(), senderId: 'AI', status: 'safe', timestamp: Date.now() }); while (roomHistories[topic].length > MAX_HISTORY_LENGTH) { roomHistories[topic].shift(); } return text; }
        else { const blockReason = result?.response?.promptFeedback?.blockReason || result?.response?.candidates?.[0]?.finishReason; console.error(`AI Gen Err ${topic}: Blocked? ${blockReason}`); return `[AI response blocked. Reason: ${blockReason || 'Filter'}.]`; }
    } catch (error) { console.error(`AI API error ${topic}:`, error); return `[AI encountered an error.]`; }
 }

// --- WebSocket Connection Handling ---
wss.on('connection', (ws) => {
    const peerId = generateId(); peers[peerId] = { ws: ws, topic: null, isAlive: true, lastActivity: Date.now() };
    console.log(`Peer connected: ${peerId}`); safeSend(ws, { type: 'your_id', id: peerId });
    ws.isAlive = true; ws.on('pong', () => { if(peers[peerId]) peers[peerId].isAlive = true; });

    ws.on('message', async (message) => { // Async
        let data; try { data = JSON.parse(message.toString()); } catch (e) { console.error(`Msg parse error ${peerId}:`, e); return; }
        if (!peers[peerId]) { console.warn(`Msg from dead peer ${peerId}`); return; }
        peers[peerId].isAlive = true; peers[peerId].lastActivity = Date.now();
        const currentTopic = peers[peerId]?.topic;
        console.log(`Received ${data.type} from ${peerId} in topic ${currentTopic || 'None'}`);

        switch (data.type) {
            case 'join':
                const newTopic = data.topic?.trim(); if (!newTopic) { safeSend(ws, {type: 'error', message: 'Topic invalid.'}); return; } const oldTopic = peers[peerId]?.topic;
                if (oldTopic && oldTopic !== newTopic && rooms[oldTopic]) { console.log(`Peer ${peerId} switching from ${oldTopic}`); if (rooms[oldTopic].delete(peerId)) { if (rooms[oldTopic].size === 0) { delete rooms[oldTopic]; delete roomHistories[oldTopic]; delete flaggedMessages[oldTopic]; } else { notifyRoomUpdate(oldTopic, `peer_left`); } if (flaggedMessages[oldTopic]) Object.keys(flaggedMessages[oldTopic]).forEach(msgId => flaggedMessages[oldTopic][msgId]?.flaggedBy?.delete(peerId)); } }
                if(peers[peerId]) { peers[peerId].topic = newTopic; } else { peers[peerId] = { ws: ws, topic: newTopic, isAlive: true, lastActivity: Date.now() }; } // Re-add if missing during cleanup race
                if (!rooms[newTopic]) { rooms[newTopic] = new Set(); roomHistories[newTopic] = []; flaggedMessages[newTopic] = {}; console.log(`Creating room: ${newTopic}`); } rooms[newTopic].add(peerId); console.log(`Peer ${peerId} added room ${newTopic}. Size: ${rooms[newTopic].size}`);
                notifyRoomUpdate(newTopic, `peer_joined:${peerId}`); break;

            case 'chat_message':
                if (!currentTopic || !rooms[currentTopic] || !data.message) return;
                let chatMsg = data.message.substring(0, 1500);
                const safetyResult = await checkMessageSafety(chatMsg); // Harmful check
                if (!safetyResult.safe) { console.warn(`Disconnecting ${peerId} unsafe msg R: ${safetyResult.reason}`); safeSend(ws, { type: 'disconnect_moderation', topic: currentTopic, reason: `AI Filter: ${safetyResult.reason}` }); setTimeout(() => cleanupPeer(peerId, 1008, "AI Mod kick"), 50); return; }
                const censoredMsg = censorMessage(chatMsg); // Basic profanity censor
                 const messageId = generateMessageId(); const historyEntry = { msgId: messageId, senderId: peerId, role: "user", parts: [{ text: chatMsg }], timestamp: Date.now(), status: 'safe' }; // Store original text in history
                 if (!roomHistories[currentTopic]) roomHistories[currentTopic] = []; roomHistories[currentTopic].push(historyEntry); while (roomHistories[currentTopic].length > MAX_HISTORY_LENGTH) { roomHistories[currentTopic].shift(); }
                 const messagePayload = { type: 'chat_message', topic: currentTopic, messageId: messageId, senderId: peerId, message: censoredMsg }; // Broadcast censored
                 broadcastToRoom(currentTopic, messagePayload, peerId); break;

            case 'flag_message':
                 if (!currentTopic || data.topic !== currentTopic) { return; } const msgIdToFlag = data.messageId; const flaggedSenderId = data.flaggedSenderId; const flaggerId = peerId;
                 if (!msgIdToFlag || !flaggedSenderId || !peers[flaggedSenderId] || flaggerId === flaggedSenderId) { safeSend(ws, { type: 'error', message: 'Invalid flag.' }); return; }
                 const messageToFlag = roomHistories[currentTopic]?.find(m => m.msgId === msgIdToFlag && m.senderId === flaggedSenderId); if (!messageToFlag || messageToFlag.status !== 'safe') { safeSend(ws, { type: 'error', message: 'Msg cannot be flagged.' }); return; }
                 if (!flaggedMessages[currentTopic]) flaggedMessages[currentTopic] = {}; if (!flaggedMessages[currentTopic][msgIdToFlag]) { flaggedMessages[currentTopic][msgIdToFlag] = { flaggedBy: new Set(), originalSender: flaggedSenderId, text: messageToFlag.parts[0].text, topic: currentTopic, status: 'pending_ai' }; }
                 const flagInfo = flaggedMessages[currentTopic][msgIdToFlag];
                 if (!flagInfo.flaggedBy.has(flaggerId)) { flagInfo.flaggedBy.add(flaggerId); console.log(`Flag count for ${msgIdToFlag}: ${flagInfo.flaggedBy.size}`); if (flagInfo.flaggedBy.size >= 1 && flagInfo.status === 'pending_ai') { console.log(`Trigger AI confirm for ${msgIdToFlag}`); const flagSafetyResult = await checkMessageSafety(flagInfo.text); if (!flagSafetyResult.safe) { flagInfo.status = 'ai_unsafe'; console.warn(`AI CONFIRMED flag ${msgIdToFlag}. Kicking ${flagInfo.originalSender}. R: ${flagSafetyResult.reason}`); if (peers[flagInfo.originalSender]) { safeSend(peers[flagInfo.originalSender].ws, { type: 'disconnect_moderation', topic: currentTopic, reason: `Flag Confirmed: ${flagSafetyResult.reason}` }); setTimeout(() => cleanupPeer(flagInfo.originalSender, 1008, "Flag kick"), 50); } const historyMsg = roomHistories[currentTopic]?.find(m => m.msgId === msgIdToFlag); if(historyMsg) historyMsg.status = 'flag_confirmed'; broadcastToRoom(currentTopic, { type: 'message_removed', messageId: msgIdToFlag }, null); } else { flagInfo.status = 'ai_safe'; console.log(`AI deemed flagged msg ${msgIdToFlag} safe.`); } } } break;

             case 'ask_ai':
                 if (!currentTopic || !rooms[currentTopic]) { safeSend(ws, { type: 'error', message: 'Must be in room.' }); return; } console.log(`AI request for: ${currentTopic} from ${peerId}`); broadcastToRoom(currentTopic, { type: 'system_message', topic: currentTopic, message: `AI is thinking...` }, null); const aiResponse = await getAIResponse(currentTopic, peerId); const aiMessagePayload = { type: 'ai_message', topic: currentTopic, message: aiResponse }; broadcastToRoom(currentTopic, aiMessagePayload, null); break;

             case 'leave': console.log(`Peer ${peerId} leaving room ${currentTopic}.`); cleanupPeer(peerId, 1000, "User left"); break;
             default: console.log(`Unknown msg type from ${peerId}: ${data.type}`); break;
        }
    });

    ws.on('close', (code, reason) => { console.log(`Peer WS closed: ${peerId} (Code: ${code})`); cleanupPeer(peerId, code, `WebSocket closed: ${reason || 'N/A'}`); });
    ws.on('error', (error) => { console.error(`WS error for ${peerId}:`, error); cleanupPeer(peerId, 1011, "WebSocket error"); });
});

// --- Heartbeat & Inactivity Intervals ---
const heartbeatInterval = setInterval(() => { wss.clients.forEach((ws) => { const c=Object.keys(peers).find(id=>peers[id]?.ws===ws); if(!c||!peers[c]){ws.terminate();return;} if(peers[c].isAlive===false){console.log(`HB fail ${c}`);cleanupPeer(c,1001,"HB timeout");return;} peers[c].isAlive=false; try{if(ws.readyState===WebSocket.OPEN)ws.ping(()=>{});else{console.log(`HB non-open ${c}`);cleanupPeer(c,1001,"HB non-open");}}catch(e){console.error(`Ping error ${c}:`,e);cleanupPeer(c,1011,"HB ping error");}});}, 30000);
const inactivityInterval = setInterval(() => { const n=Date.now(); Object.keys(peers).forEach(p=>{const d=peers[p]; if(d&&d.lastActivity){const i=n-d.lastActivity; if(i>INACTIVITY_TIMEOUT){console.warn(`Peer ${p} inactive ${Math.round(i/1000)}s. DC.`); safeSend(d.ws,{type:'disconnect_inactive',topic:d.topic}); setTimeout(()=>cleanupPeer(p,1001,"Inactive"),50);}} else if(d&&!d.lastActivity){d.lastActivity=n;}});}, ACTIVITY_CHECK_INTERVAL);
wss.on('close', () => { clearInterval(heartbeatInterval); clearInterval(inactivityInterval); });

console.log("Server setup complete.");
