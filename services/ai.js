/**
 * AI Service - Claude AI Integration
 * ResultMarketing CRM
 */

const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');

// Initialize Anthropic client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || '',
});

// Initialize OpenAI client (backup/voice processing)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || '',
});

// System prompt for CRM assistant
const CRM_SYSTEM_PROMPT = `You are an AI assistant for ResultMarketing CRM, a customer relationship management system designed for Malaysian sales professionals.

Your role is to help users:
1. Find and manage contacts (search by name, company, industry, etc.)
2. Track interactions and follow-ups
3. Manage sales opportunities and pipeline
4. Schedule reminders and tasks
5. Analyze sales performance
6. Provide business insights in the Malaysian market context

Guidelines:
- Be concise and professional
- Use Malaysian Ringgit (RM) for currency references
- Understand Malaysian business culture and practices
- Support both English and Bahasa Malaysia
- When showing contact lists, format them clearly
- For large datasets (>50 records), summarize and offer to paginate
- Protect sensitive customer information
- Always confirm before making changes to data

Available actions you can suggest:
- Search contacts
- Create/update contacts
- Log interactions
- Schedule follow-ups
- View pipeline statistics
- Export data

Respond in a helpful, conversational manner while being efficient with the user's time.`;

/**
 * Send message to Claude AI
 * @param {string} userMessage - User's message
 * @param {Array} conversationHistory - Previous messages in conversation
 * @param {object} context - Additional context (contacts, stats, etc.)
 * @returns {Promise<{success: boolean, response?: string, error?: string}>}
 */
async function sendChatMessage(userMessage, conversationHistory = [], context = {}) {
  try {
    // Build messages array
    const messages = [
      ...conversationHistory.map(msg => ({
        role: msg.role,
        content: msg.content,
      })),
      {
        role: 'user',
        content: buildUserMessageWithContext(userMessage, context),
      },
    ];

    const response = await anthropic.messages.create({
      model: process.env.CLAUDE_MODEL || 'claude-3-sonnet-20240229',
      max_tokens: 1024,
      system: CRM_SYSTEM_PROMPT,
      messages: messages,
    });

    const assistantMessage = response.content[0].text;

    return {
      success: true,
      response: assistantMessage,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  } catch (err) {
    console.error('Claude AI error:', err);

    // Fallback to OpenAI if Claude fails
    if (process.env.OPENAI_API_KEY) {
      return sendChatMessageOpenAI(userMessage, conversationHistory, context);
    }

    return { success: false, error: err.message };
  }
}

/**
 * Build user message with context
 * @param {string} userMessage - User's message
 * @param {object} context - Additional context
 * @returns {string}
 */
function buildUserMessageWithContext(userMessage, context) {
  let contextStr = '';

  if (context.contacts && context.contacts.length > 0) {
    contextStr += '\n\n[Relevant Contacts Context]\n';
    if (context.contacts.length <= 10) {
      contextStr += context.contacts.map(c =>
        `- ${c.name} | ${c.company || 'No company'} | ${c.phone || 'No phone'} | ${c.email || 'No email'}`
      ).join('\n');
    } else {
      contextStr += `Total: ${context.contacts.length} contacts found. Showing first 10:\n`;
      contextStr += context.contacts.slice(0, 10).map(c =>
        `- ${c.name} | ${c.company || 'No company'} | ${c.phone || 'No phone'}`
      ).join('\n');
    }
  }

  if (context.stats) {
    contextStr += '\n\n[Current Statistics]\n';
    contextStr += JSON.stringify(context.stats, null, 2);
  }

  if (context.recentInteractions && context.recentInteractions.length > 0) {
    contextStr += '\n\n[Recent Interactions]\n';
    contextStr += context.recentInteractions.slice(0, 5).map(i =>
      `- ${i.date}: ${i.type} with ${i.contact_name} - ${i.notes || 'No notes'}`
    ).join('\n');
  }

  return userMessage + contextStr;
}

/**
 * Fallback to OpenAI GPT-4
 * @param {string} userMessage - User's message
 * @param {Array} conversationHistory - Previous messages
 * @param {object} context - Additional context
 * @returns {Promise<{success: boolean, response?: string, error?: string}>}
 */
async function sendChatMessageOpenAI(userMessage, conversationHistory = [], context = {}) {
  try {
    const messages = [
      { role: 'system', content: CRM_SYSTEM_PROMPT },
      ...conversationHistory.map(msg => ({
        role: msg.role,
        content: msg.content,
      })),
      {
        role: 'user',
        content: buildUserMessageWithContext(userMessage, context),
      },
    ];

    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4-turbo-preview',
      messages: messages,
      max_tokens: 1024,
      temperature: 0.7,
    });

    return {
      success: true,
      response: response.choices[0].message.content,
      usage: {
        inputTokens: response.usage.prompt_tokens,
        outputTokens: response.usage.completion_tokens,
      },
      model: 'openai-fallback',
    };
  } catch (err) {
    console.error('OpenAI fallback error:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Analyze spreadsheet data with AI
 * @param {Array} rows - Spreadsheet rows
 * @param {Array} headers - Column headers
 * @returns {Promise<{success: boolean, analysis?: object, error?: string}>}
 */
async function analyzeSpreadsheetData(rows, headers) {
  try {
    const sampleData = rows.slice(0, 10);

    const prompt = `Analyze this spreadsheet data and identify the column mappings for a CRM contact import.

Headers: ${JSON.stringify(headers)}

Sample data (first 10 rows):
${JSON.stringify(sampleData, null, 2)}

Please identify which columns map to:
- name (contact full name)
- phone (phone number)
- email (email address)
- company (company name)
- industry (business industry/category)
- position (job title)
- address (location/address)
- notes (additional notes)

Also detect:
- Phone number format (Malaysian: +60, 01x, etc.)
- Potential duplicates in sample
- Data quality issues

Respond in JSON format:
{
  "columnMappings": {
    "name": "column_name or null",
    "phone": "column_name or null",
    "email": "column_name or null",
    "company": "column_name or null",
    "industry": "column_name or null",
    "position": "column_name or null",
    "address": "column_name or null",
    "notes": "column_name or null"
  },
  "phoneFormat": "detected format",
  "dataQualityIssues": ["list of issues"],
  "suggestedCleanups": ["list of suggestions"],
  "confidence": 0.0-1.0
}`;

    const response = await anthropic.messages.create({
      model: process.env.CLAUDE_MODEL || 'claude-3-sonnet-20240229',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });

    const responseText = response.content[0].text;

    // Extract JSON from response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const analysis = JSON.parse(jsonMatch[0]);
      return { success: true, analysis };
    }

    return { success: false, error: 'Could not parse AI response' };
  } catch (err) {
    console.error('Spreadsheet analysis error:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Extract text from image using OpenAI Vision
 * @param {string} imageBase64 - Base64 encoded image
 * @returns {Promise<{success: boolean, text?: string, structured?: object, error?: string}>}
 */
async function extractNamecardText(imageBase64) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4-turbo',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Extract all text from this business card image and structure it as JSON:
{
  "name": "full name",
  "position": "job title",
  "company": "company name",
  "phone": "phone number (prefer mobile)",
  "email": "email address",
  "address": "address if visible",
  "website": "website if visible",
  "additional_phones": ["other phone numbers"],
  "raw_text": "all text found on card",
  "confidence": 0.0-1.0,
  "language": "detected language"
}

Handle Malaysian phone formats (+60, 01x-xxx xxxx).
If information is unclear, use null.`,
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:image/jpeg;base64,${imageBase64}`,
              },
            },
          ],
        },
      ],
      max_tokens: 500,
    });

    const responseText = response.choices[0].message.content;
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);

    if (jsonMatch) {
      const structured = JSON.parse(jsonMatch[0]);
      return {
        success: true,
        text: structured.raw_text,
        structured,
      };
    }

    return { success: true, text: responseText, structured: null };
  } catch (err) {
    console.error('Namecard extraction error:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Transcribe voice memo
 * @param {Buffer} audioBuffer - Audio file buffer
 * @returns {Promise<{success: boolean, text?: string, error?: string}>}
 */
async function transcribeVoice(audioBuffer) {
  try {
    const transcription = await openai.audio.transcriptions.create({
      file: audioBuffer,
      model: 'whisper-1',
      language: 'en', // Can detect Malay as well
    });

    return { success: true, text: transcription.text };
  } catch (err) {
    console.error('Voice transcription error:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Generate follow-up suggestions
 * @param {object} contact - Contact information
 * @param {Array} interactions - Recent interactions
 * @returns {Promise<{success: boolean, suggestions?: Array, error?: string}>}
 */
async function generateFollowUpSuggestions(contact, interactions = []) {
  try {
    const prompt = `Based on this contact and interaction history, suggest follow-up actions:

Contact:
${JSON.stringify(contact, null, 2)}

Recent Interactions:
${JSON.stringify(interactions.slice(0, 5), null, 2)}

Suggest 2-3 follow-up actions with:
- Suggested date/timing
- Type of follow-up (call, email, meeting, WhatsApp)
- Brief message template
- Priority (high, medium, low)

Consider Malaysian business culture (respect for hierarchy, relationship-building importance, typical business hours).

Respond in JSON:
{
  "suggestions": [
    {
      "action": "description",
      "type": "call|email|meeting|whatsapp",
      "suggestedDate": "YYYY-MM-DD",
      "suggestedTime": "HH:mm",
      "priority": "high|medium|low",
      "messageTemplate": "brief message"
    }
  ]
}`;

    const response = await anthropic.messages.create({
      model: process.env.CLAUDE_MODEL || 'claude-3-sonnet-20240229',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });

    const responseText = response.content[0].text;
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);

    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      return { success: true, suggestions: result.suggestions };
    }

    return { success: false, error: 'Could not parse suggestions' };
  } catch (err) {
    console.error('Follow-up suggestion error:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Categorize contact by industry
 * @param {object} contact - Contact information
 * @returns {Promise<{success: boolean, category?: string, confidence?: number, error?: string}>}
 */
async function categorizeContact(contact) {
  try {
    const prompt = `Categorize this business contact into an industry:

Name: ${contact.name}
Company: ${contact.company || 'Unknown'}
Position: ${contact.position || 'Unknown'}
Email domain: ${contact.email ? contact.email.split('@')[1] : 'Unknown'}

Malaysian industry categories:
- Technology & IT
- Finance & Banking
- Healthcare & Medical
- Property & Real Estate
- Manufacturing
- Retail & Consumer
- F&B & Hospitality
- Education
- Professional Services
- Government & GLC
- Construction & Engineering
- Media & Entertainment
- Other

Respond with JSON:
{
  "category": "category name",
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation"
}`;

    const response = await anthropic.messages.create({
      model: process.env.CLAUDE_MODEL || 'claude-3-sonnet-20240229',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });

    const responseText = response.content[0].text;
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);

    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      return {
        success: true,
        category: result.category,
        confidence: result.confidence,
      };
    }

    return { success: false, error: 'Could not categorize' };
  } catch (err) {
    console.error('Categorization error:', err);
    return { success: false, error: err.message };
  }
}

module.exports = {
  sendChatMessage,
  sendChatMessageOpenAI,
  analyzeSpreadsheetData,
  extractNamecardText,
  transcribeVoice,
  generateFollowUpSuggestions,
  categorizeContact,
};
