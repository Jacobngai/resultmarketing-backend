/**
 * Interaction Routes
 * ResultMarketing CRM
 */

const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase');
const { authenticateToken } = require('../middleware/auth');

// Valid interaction types
const INTERACTION_TYPES = [
  'call',
  'email',
  'meeting',
  'whatsapp',
  'sms',
  'social',
  'note',
  'other',
];

/**
 * Validate interaction data
 */
function validateInteraction(data) {
  const errors = [];

  if (!data.contact_id) {
    errors.push('Contact ID is required');
  }

  if (!data.type || !INTERACTION_TYPES.includes(data.type)) {
    errors.push(`Type must be one of: ${INTERACTION_TYPES.join(', ')}`);
  }

  if (data.interaction_date) {
    const date = new Date(data.interaction_date);
    if (isNaN(date.getTime())) {
      errors.push('Invalid interaction date');
    }
  }

  return errors;
}

/**
 * GET /api/interactions
 * List interactions with pagination
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      page = 1,
      limit = 50,
      contact_id,
      type,
      startDate,
      endDate,
      sort = 'interaction_date',
      order = 'desc',
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = supabase
      .from('interactions')
      .select(
        `
        *,
        contacts!inner(id, name, company, phone, email)
      `,
        { count: 'exact' }
      )
      .eq('user_id', userId);

    // Apply filters
    if (contact_id) {
      query = query.eq('contact_id', contact_id);
    }
    if (type) {
      query = query.eq('type', type);
    }
    if (startDate) {
      query = query.gte('interaction_date', startDate);
    }
    if (endDate) {
      query = query.lte('interaction_date', endDate);
    }

    // Apply sorting
    const ascending = order.toLowerCase() === 'asc';
    query = query
      .order(sort, { ascending })
      .range(offset, offset + parseInt(limit) - 1);

    const { data, error, count } = await query;

    if (error) {
      throw error;
    }

    return res.status(200).json({
      success: true,
      data: {
        interactions: data,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: count,
          totalPages: Math.ceil(count / parseInt(limit)),
        },
      },
      error: null,
    });
  } catch (err) {
    console.error('List interactions error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch interactions',
      },
    });
  }
});

/**
 * GET /api/interactions/recent
 * Get recent interactions
 */
router.get('/recent', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { limit = 10 } = req.query;

    const { data, error } = await supabase
      .from('interactions')
      .select(
        `
        *,
        contacts(id, name, company, phone)
      `
      )
      .eq('user_id', userId)
      .order('interaction_date', { ascending: false })
      .limit(parseInt(limit));

    if (error) {
      throw error;
    }

    return res.status(200).json({
      success: true,
      data: {
        interactions: data,
      },
      error: null,
    });
  } catch (err) {
    console.error('Recent interactions error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch recent interactions',
      },
    });
  }
});

/**
 * GET /api/interactions/stats
 * Get interaction statistics
 */
router.get('/stats', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { period = '30' } = req.query;

    const daysAgo = new Date();
    daysAgo.setDate(daysAgo.getDate() - parseInt(period));

    // Get total count
    const { count: totalCount } = await supabase
      .from('interactions')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);

    // Get counts by type
    const { data: typeData } = await supabase
      .from('interactions')
      .select('type')
      .eq('user_id', userId)
      .gte('interaction_date', daysAgo.toISOString());

    const typeStats = typeData?.reduce((acc, item) => {
      acc[item.type] = (acc[item.type] || 0) + 1;
      return acc;
    }, {});

    // Get daily counts for the period
    const { data: dailyData } = await supabase
      .from('interactions')
      .select('interaction_date')
      .eq('user_id', userId)
      .gte('interaction_date', daysAgo.toISOString())
      .order('interaction_date', { ascending: true });

    const dailyStats = dailyData?.reduce((acc, item) => {
      const date = item.interaction_date.split('T')[0];
      acc[date] = (acc[date] || 0) + 1;
      return acc;
    }, {});

    // Recent period count
    const recentCount = typeData?.length || 0;

    return res.status(200).json({
      success: true,
      data: {
        total: totalCount || 0,
        period: parseInt(period),
        recentCount,
        byType: typeStats || {},
        byDay: dailyStats || {},
        averagePerDay: recentCount / parseInt(period),
      },
      error: null,
    });
  } catch (err) {
    console.error('Interaction stats error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to get interaction statistics',
      },
    });
  }
});

/**
 * GET /api/interactions/:id
 * Get single interaction
 */
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const { data, error } = await supabase
      .from('interactions')
      .select(
        `
        *,
        contacts(id, name, company, phone, email)
      `
      )
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({
          success: false,
          data: null,
          error: {
            code: 'NOT_FOUND',
            message: 'Interaction not found',
          },
        });
      }
      throw error;
    }

    return res.status(200).json({
      success: true,
      data: {
        interaction: data,
      },
      error: null,
    });
  } catch (err) {
    console.error('Get interaction error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch interaction',
      },
    });
  }
});

/**
 * POST /api/interactions
 * Log new interaction
 */
router.post('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      contact_id,
      type,
      notes,
      outcome,
      duration_minutes,
      interaction_date,
      follow_up_date,
      metadata,
    } = req.body;

    // Validate input
    const validationErrors = validateInteraction({ contact_id, type, interaction_date });
    if (validationErrors.length > 0) {
      return res.status(400).json({
        success: false,
        data: null,
        error: {
          code: 'VALIDATION_ERROR',
          message: validationErrors.join(', '),
        },
      });
    }

    // Verify contact ownership
    const { data: contact, error: contactError } = await supabase
      .from('contacts')
      .select('id, name')
      .eq('id', contact_id)
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

    // Create interaction
    const { data, error } = await supabase
      .from('interactions')
      .insert({
        user_id: userId,
        contact_id,
        type,
        notes: notes?.trim() || null,
        outcome: outcome?.trim() || null,
        duration_minutes: duration_minutes || null,
        interaction_date: interaction_date || new Date().toISOString(),
        follow_up_date: follow_up_date || null,
        metadata: metadata || {},
      })
      .select()
      .single();

    if (error) {
      throw error;
    }

    // Update contact's last_interaction timestamp
    await supabase
      .from('contacts')
      .update({ last_interaction: data.interaction_date })
      .eq('id', contact_id);

    // Create follow-up reminder if date provided
    if (follow_up_date) {
      await supabase.from('reminders').insert({
        user_id: userId,
        contact_id,
        title: `Follow up with ${contact.name}`,
        description: `Follow up after ${type}: ${notes || 'No notes'}`,
        due_date: follow_up_date,
        type: 'follow_up',
        priority: 'medium',
        status: 'pending',
      });
    }

    return res.status(201).json({
      success: true,
      data: {
        interaction: data,
      },
      error: null,
    });
  } catch (err) {
    console.error('Create interaction error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to create interaction',
      },
    });
  }
});

/**
 * PUT /api/interactions/:id
 * Update interaction
 */
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const updates = req.body;

    // Validate type if being updated
    if (updates.type && !INTERACTION_TYPES.includes(updates.type)) {
      return res.status(400).json({
        success: false,
        data: null,
        error: {
          code: 'INVALID_TYPE',
          message: `Type must be one of: ${INTERACTION_TYPES.join(', ')}`,
        },
      });
    }

    // Remove fields that shouldn't be updated
    delete updates.id;
    delete updates.user_id;
    delete updates.contact_id;
    delete updates.created_at;

    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('interactions')
      .update(updates)
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({
          success: false,
          data: null,
          error: {
            code: 'NOT_FOUND',
            message: 'Interaction not found',
          },
        });
      }
      throw error;
    }

    return res.status(200).json({
      success: true,
      data: {
        interaction: data,
      },
      error: null,
    });
  } catch (err) {
    console.error('Update interaction error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to update interaction',
      },
    });
  }
});

/**
 * DELETE /api/interactions/:id
 * Delete interaction
 */
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const { error } = await supabase
      .from('interactions')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);

    if (error) {
      throw error;
    }

    return res.status(200).json({
      success: true,
      data: {
        message: 'Interaction deleted successfully',
        id: id,
      },
      error: null,
    });
  } catch (err) {
    console.error('Delete interaction error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to delete interaction',
      },
    });
  }
});

module.exports = router;
