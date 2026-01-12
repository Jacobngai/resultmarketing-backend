/**
 * Chat Routes (AI Assistant)
 * ResultMarketing CRM
 */

const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase');
const {
  sendChatMessage,
  generateFollowUpSuggestions,
  categorizeContact,
} = require('../services/ai');
const { authenticateToken } = require('../middleware/auth');
const { chatRateLimit } = require('../middleware/rateLimit');

// Maximum context window for AI
const MAX_CONTEXT_CONTACTS = 50;
const MAX_HISTORY_MESSAGES = 20;

/**
 * POST /api/chat
 * Send message to AI assistant
 */
router.post('/', authenticateToken, chatRateLimit, async (req, res) => {
  try {
    const userId = req.user.id;
    const { message, conversationId, includeContext = true } = req.body;

    if (!message || message.trim().length === 0) {
      return res.status(400).json({
        success: false,
        data: null,
        error: {
          code: 'EMPTY_MESSAGE',
          message: 'Message is required',
        },
      });
    }

    // Get or create conversation
    let conversation = conversationId;
    if (!conversationId) {
      const { data: newConv, error: convError } = await supabase
        .from('chat_conversations')
        .insert({
          user_id: userId,
          title: message.substring(0, 50) + (message.length > 50 ? '...' : ''),
        })
        .select()
        .single();

      if (convError) {
        console.error('Create conversation error:', convError);
        // Continue without saving
      } else {
        conversation = newConv.id;
      }
    }

    // Get conversation history
    let conversationHistory = [];
    if (conversation) {
      const { data: history } = await supabase
        .from('chat_messages')
        .select('role, content')
        .eq('conversation_id', conversation)
        .order('created_at', { ascending: true })
        .limit(MAX_HISTORY_MESSAGES);

      conversationHistory = history || [];
    }

    // Build context
    let context = {};
    if (includeContext) {
      context = await buildContext(userId, message);
    }

    // Send to AI
    const result = await sendChatMessage(message, conversationHistory, context);

    if (!result.success) {
      return res.status(500).json({
        success: false,
        data: null,
        error: {
          code: 'AI_ERROR',
          message: result.error || 'Failed to get AI response',
        },
      });
    }

    // Save messages
    if (conversation) {
      await supabase.from('chat_messages').insert([
        {
          conversation_id: conversation,
          user_id: userId,
          role: 'user',
          content: message,
        },
        {
          conversation_id: conversation,
          user_id: userId,
          role: 'assistant',
          content: result.response,
        },
      ]);

      // Update conversation last message
      await supabase
        .from('chat_conversations')
        .update({ last_message_at: new Date().toISOString() })
        .eq('id', conversation);
    }

    return res.status(200).json({
      success: true,
      data: {
        response: result.response,
        conversationId: conversation,
        usage: result.usage,
        contextUsed: Object.keys(context).filter((k) => context[k]),
      },
      error: null,
    });
  } catch (err) {
    console.error('Chat error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to process chat message',
      },
    });
  }
});

/**
 * GET /api/chat/history
 * Get chat history
 */
router.get('/history', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { conversationId, limit = 50 } = req.query;

    let query = supabase
      .from('chat_messages')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
      .limit(parseInt(limit));

    if (conversationId) {
      query = query.eq('conversation_id', conversationId);
    }

    const { data, error } = await query;

    if (error) {
      throw error;
    }

    return res.status(200).json({
      success: true,
      data: {
        messages: data,
        count: data.length,
      },
      error: null,
    });
  } catch (err) {
    console.error('Chat history error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch chat history',
      },
    });
  }
});

/**
 * GET /api/chat/conversations
 * Get chat conversations list
 */
router.get('/conversations', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { limit = 20, offset = 0 } = req.query;

    const { data, error, count } = await supabase
      .from('chat_conversations')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .order('last_message_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (error) {
      throw error;
    }

    return res.status(200).json({
      success: true,
      data: {
        conversations: data,
        total: count,
      },
      error: null,
    });
  } catch (err) {
    console.error('Conversations list error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch conversations',
      },
    });
  }
});

/**
 * DELETE /api/chat/conversations/:id
 * Delete a conversation
 */
router.delete('/conversations/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    // Delete messages first
    await supabase
      .from('chat_messages')
      .delete()
      .eq('conversation_id', id)
      .eq('user_id', userId);

    // Delete conversation
    const { error } = await supabase
      .from('chat_conversations')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);

    if (error) {
      throw error;
    }

    return res.status(200).json({
      success: true,
      data: {
        message: 'Conversation deleted successfully',
      },
      error: null,
    });
  } catch (err) {
    console.error('Delete conversation error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to delete conversation',
      },
    });
  }
});

/**
 * POST /api/chat/suggest-followups
 * Get AI-generated follow-up suggestions for a contact
 */
router.post('/suggest-followups', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { contactId } = req.body;

    if (!contactId) {
      return res.status(400).json({
        success: false,
        data: null,
        error: {
          code: 'MISSING_CONTACT',
          message: 'Contact ID is required',
        },
      });
    }

    // Get contact
    const { data: contact, error: contactError } = await supabase
      .from('contacts')
      .select('*')
      .eq('id', contactId)
      .eq('user_id', userId)
      .single();

    if (contactError || !contact) {
      return res.status(404).json({
        success: false,
        data: null,
        error: {
          code: 'CONTACT_NOT_FOUND',
          message: 'Contact not found',
        },
      });
    }

    // Get recent interactions
    const { data: interactions } = await supabase
      .from('interactions')
      .select('*')
      .eq('contact_id', contactId)
      .order('interaction_date', { ascending: false })
      .limit(10);

    // Get AI suggestions
    const result = await generateFollowUpSuggestions(contact, interactions || []);

    if (!result.success) {
      return res.status(500).json({
        success: false,
        data: null,
        error: {
          code: 'AI_ERROR',
          message: result.error || 'Failed to generate suggestions',
        },
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        contact: { id: contact.id, name: contact.name },
        suggestions: result.suggestions,
      },
      error: null,
    });
  } catch (err) {
    console.error('Follow-up suggestions error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to generate suggestions',
      },
    });
  }
});

/**
 * POST /api/chat/categorize
 * Categorize a contact by industry using AI
 */
router.post('/categorize', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { contactId } = req.body;

    if (!contactId) {
      return res.status(400).json({
        success: false,
        data: null,
        error: {
          code: 'MISSING_CONTACT',
          message: 'Contact ID is required',
        },
      });
    }

    // Get contact
    const { data: contact, error: contactError } = await supabase
      .from('contacts')
      .select('*')
      .eq('id', contactId)
      .eq('user_id', userId)
      .single();

    if (contactError || !contact) {
      return res.status(404).json({
        success: false,
        data: null,
        error: {
          code: 'CONTACT_NOT_FOUND',
          message: 'Contact not found',
        },
      });
    }

    // Get AI categorization
    const result = await categorizeContact(contact);

    if (!result.success) {
      return res.status(500).json({
        success: false,
        data: null,
        error: {
          code: 'AI_ERROR',
          message: result.error || 'Failed to categorize contact',
        },
      });
    }

    // Update contact if confidence is high enough
    if (result.confidence >= 0.7) {
      await supabase
        .from('contacts')
        .update({ industry: result.category })
        .eq('id', contactId);
    }

    return res.status(200).json({
      success: true,
      data: {
        contact: { id: contact.id, name: contact.name },
        category: result.category,
        confidence: result.confidence,
        applied: result.confidence >= 0.7,
      },
      error: null,
    });
  } catch (err) {
    console.error('Categorize error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to categorize contact',
      },
    });
  }
});

/**
 * POST /api/chat/quick-action
 * Execute quick action from AI suggestion
 */
router.post('/quick-action', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { action, params } = req.body;

    if (!action) {
      return res.status(400).json({
        success: false,
        data: null,
        error: {
          code: 'MISSING_ACTION',
          message: 'Action is required',
        },
      });
    }

    let result;

    switch (action) {
      case 'create_reminder':
        result = await createReminderFromAction(userId, params);
        break;

      case 'log_interaction':
        result = await logInteractionFromAction(userId, params);
        break;

      case 'search_contacts':
        result = await searchContactsFromAction(userId, params);
        break;

      default:
        return res.status(400).json({
          success: false,
          data: null,
          error: {
            code: 'UNKNOWN_ACTION',
            message: `Unknown action: ${action}`,
          },
        });
    }

    return res.status(200).json({
      success: true,
      data: result,
      error: null,
    });
  } catch (err) {
    console.error('Quick action error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to execute action',
      },
    });
  }
});

/**
 * Build context for AI based on message intent
 */
async function buildContext(userId, message) {
  const context = {};
  const lowerMessage = message.toLowerCase();

  // Check if user is asking about contacts
  if (
    lowerMessage.includes('contact') ||
    lowerMessage.includes('client') ||
    lowerMessage.includes('customer') ||
    lowerMessage.includes('find') ||
    lowerMessage.includes('search')
  ) {
    // Extract potential search terms
    const searchTerms = extractSearchTerms(message);

    if (searchTerms) {
      const { data: contacts } = await supabase
        .from('contacts')
        .select('id, name, company, phone, email, industry, last_interaction')
        .eq('user_id', userId)
        .or(
          `name.ilike.%${searchTerms}%,company.ilike.%${searchTerms}%,email.ilike.%${searchTerms}%`
        )
        .limit(MAX_CONTEXT_CONTACTS);

      context.contacts = contacts || [];
    }
  }

  // Check if asking about stats/summary
  if (
    lowerMessage.includes('stats') ||
    lowerMessage.includes('summary') ||
    lowerMessage.includes('overview') ||
    lowerMessage.includes('how many')
  ) {
    // Get contact count
    const { count: contactCount } = await supabase
      .from('contacts')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);

    // Get interaction count (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const { count: interactionCount } = await supabase
      .from('interactions')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('interaction_date', thirtyDaysAgo.toISOString());

    // Get pending reminders
    const { count: pendingReminders } = await supabase
      .from('reminders')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('status', 'pending');

    // Get active opportunities
    const { data: opportunities } = await supabase
      .from('opportunities')
      .select('value, stage')
      .eq('user_id', userId)
      .eq('status', 'active');

    const pipelineValue = opportunities?.reduce((sum, o) => sum + (o.value || 0), 0) || 0;

    context.stats = {
      totalContacts: contactCount || 0,
      recentInteractions: interactionCount || 0,
      pendingReminders: pendingReminders || 0,
      activeOpportunities: opportunities?.length || 0,
      pipelineValue,
    };
  }

  // Check if asking about recent activity
  if (
    lowerMessage.includes('recent') ||
    lowerMessage.includes('latest') ||
    lowerMessage.includes('last')
  ) {
    const { data: interactions } = await supabase
      .from('interactions')
      .select(
        `
        id, type, notes, interaction_date,
        contacts(name)
      `
      )
      .eq('user_id', userId)
      .order('interaction_date', { ascending: false })
      .limit(10);

    context.recentInteractions = interactions?.map((i) => ({
      ...i,
      contact_name: i.contacts?.name,
      date: i.interaction_date,
    })) || [];
  }

  return context;
}

/**
 * Extract search terms from message
 */
function extractSearchTerms(message) {
  // Remove common words
  const stopWords = [
    'find', 'search', 'look', 'for', 'the', 'a', 'an', 'contact', 'client',
    'customer', 'named', 'called', 'from', 'at', 'in', 'who', 'where',
  ];

  const words = message
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter((w) => !stopWords.includes(w) && w.length > 2);

  return words.join(' ') || null;
}

/**
 * Create reminder from quick action
 */
async function createReminderFromAction(userId, params) {
  const { contactId, title, dueDate, type = 'follow_up' } = params;

  const { data, error } = await supabase
    .from('reminders')
    .insert({
      user_id: userId,
      contact_id: contactId,
      title,
      due_date: dueDate || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      type,
      priority: 'medium',
      status: 'pending',
    })
    .select()
    .single();

  if (error) throw error;
  return { reminder: data };
}

/**
 * Log interaction from quick action
 */
async function logInteractionFromAction(userId, params) {
  const { contactId, type, notes } = params;

  const { data, error } = await supabase
    .from('interactions')
    .insert({
      user_id: userId,
      contact_id: contactId,
      type: type || 'note',
      notes,
      interaction_date: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) throw error;

  // Update contact's last_interaction
  await supabase
    .from('contacts')
    .update({ last_interaction: new Date().toISOString() })
    .eq('id', contactId);

  return { interaction: data };
}

/**
 * Search contacts from quick action
 */
async function searchContactsFromAction(userId, params) {
  const { query, limit = 10 } = params;

  const { data, error } = await supabase
    .from('contacts')
    .select('id, name, company, phone, email')
    .eq('user_id', userId)
    .or(
      `name.ilike.%${query}%,company.ilike.%${query}%,email.ilike.%${query}%`
    )
    .limit(limit);

  if (error) throw error;
  return { contacts: data };
}

module.exports = router;
