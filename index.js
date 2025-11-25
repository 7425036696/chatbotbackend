// server/index.js
// Simple Express proxy for Gemini 2.5 Flash for Shopify widget
// NOTE: Replace the REST endpoint or SDK call with the exact method from Google's docs if you prefer SDK.
// Keep your GENAI_API_KEY in environment variables.

const express = require('express');
const fetch = require('node-fetch'); // or native fetch in Node 18+
const bodyParser = require('body-parser');
const crypto = require('crypto');
const dotenv = require('dotenv');
dotenv.config();
const app = express();
app.use(bodyParser.json());

// Basic in-memory session store (for demo). Use Redis/DB for production.
const sessions = new Map();

const GENAI_API_KEY = process.env.GENAI_API_KEY;
if (!GENAI_API_KEY) {
  console.error('Set GENAI_API_KEY env var!');
  process.exit(1);
}

// Helper: get or create session
function getSession(id) {
  if (!id) {
    id = crypto.randomBytes(12).toString('hex');
  }
  if (!sessions.has(id)) sessions.set(id, { messages: [] });
  return { id, state: sessions.get(id) };
}

// Basic function to build model prompt/context for ecommerce
function buildPrompt(storeMeta, conversation, userMessage) {
  // storeMeta: { name, url, currency, shipping, faq: [{q,a}], topProducts: [...] }
  // conversation: [{role:'user'|'assistant', text}]
  // We'll provide a system instruction + recent turns
  const system = [
    `You are an ecommerce assistant for ${storeMeta.name}.`,
    `Store URL: ${storeMeta.url}`,
    `Currency: ${storeMeta.currency}. Shipping policy: ${storeMeta.shipping}.`,
    `Answer customer queries concisely, politely, and include product links when relevant.`,
    `If a user asks for order status or personal orders, say: "I cannot access orders here; please contact support at ${storeMeta.supportEmail}".`,
    `You must not invent pricing or availability — if unsure, ask user to check product page.`
  ].join(' ');

  const recent = conversation.slice(-6).map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`).join('\n');

  // A short grounding of top products and FAQs (safe small snippets)
  const grounding = [
    'Top products (brief):',
    ...(storeMeta.topProducts || []).slice(0,6).map(p => `- ${p.title} — ${p.price} — ${p.url}`),
    'FAQ:',
    ...(storeMeta.faq || []).slice(0,6).map(f => `Q: ${f.q}\nA: ${f.a}`)
  ].join('\n');

  // Final prompt
  return `${system}\n\n${grounding}\n\nConversation:\n${recent}\nUser: ${userMessage}\n\nAssistant:`;
}

// **IMPORTANT**: The REST path below is a placeholder. Use the exact REST endpoint or official SDK call per Google docs.
// See: Google GenAI JS SDK or Gemini REST docs (links below).
const GEMINI_REST_URL = 'https://api.generativeai.googleapis.com/v1beta/models/gemini-2.5-flash:generate';

app.post('/api/chat', async (req, res) => {
  try {
    const { message, sessionId, storeMeta = {} } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    const { id, state } = getSession(sessionId);
    state.messages.push({ role: 'user', text: message });

    // Limit conversation context to last N messages to avoid long tokens
    const prompt = buildPrompt(storeMeta, state.messages, message);

    // Call Gemini REST (server-side) — keep API key secret
    // NOTE: adapt request body to the exact schema required by whichever endpoint/SDK you use.
    const body = {
      model: 'gemini-2.5-flash',
      prompt: prompt,
      // temperature, max_output_tokens, etc. adjust as needed
      temperature: 0.2,
      max_output_tokens: 512
    };

    const r = await fetch(GEMINI_REST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GENAI_API_KEY}`
      },
      body: JSON.stringify(body)
    });

    if (!r.ok) {
      const text = await r.text();
      console.error('GenAI error', r.status, text);
      return res.status(502).json({ error: 'genai_error', detail: text });
    }

    const result = await r.json();

    // NOTE: response parsing depends on the endpoint; adapt as needed.
    // We'll assume result.choices[0].text or result.output[0].content etc.
    // Try multiple fallbacks:
    let assistantText = '';

    if (result.output && result.output.length > 0 && result.output[0].content) {
      // some Gemini responses put text inside output[].content
      assistantText = result.output[0].content[0]?.text || result.output[0].contentText || JSON.stringify(result.output[0].content);
    } else if (result.choices && result.choices[0] && result.choices[0].message) {
      assistantText = result.choices[0].message.content;
    } else if (result.choices && result.choices[0] && result.choices[0].text) {
      assistantText = result.choices[0].text;
    } else {
      assistantText = JSON.stringify(result).slice(0, 2000);
    }

    state.messages.push({ role: 'assistant', text: assistantText });

    res.json({ sessionId: id, reply: assistantText });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server_error', detail: String(err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
