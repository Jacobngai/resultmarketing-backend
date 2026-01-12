/**
 * Reminders Routes
 * ResultMarketing CRM
 */

const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase');
const { authenticateToken } = require('../middleware/auth');

// Reminder types
const REMINDER_TYPES = ['follow_up', 'call', 'meeting', 'email', 'task', 'other'];

// Priority levels
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

// Status types
const STATUSES = ['pending', 'completed', 'snoozed', 'cancelled'];

/**
 * Validate reminder data
 */
function validateReminder(data) {
  const errors = [];

  if (!data.title || data.title.trim().length < 2) {
    errors.push('Title is required (minimum 2 characters)');
  }

  if (!data.due_date) {
    errors.push('Due date is required');
  } else {
    const date = new Date(data.due_date);
    if (isNaN(date.getTime())) {
      errors.push('Invalid due date');
    }
  }

  if (data.type && !REMINDER_TYPES.includes(data.type)) {
    errors.push(`Type must be one of: ${REMINDER_TYPES.join(', ')}`);
  }

  if (data.priority && !PRIORITIES.includes(data.priority)) {
    errors.push(`Priority must be one of: ${PRIORITIES.join(', ')}`);
  }

  return errors;
}

/**
 * GET /api/reminders
 * List reminders with filtering
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      page = 1,
      limit = 50,
      status,
      type,
      priority,
      contact_id,
      startDate,
      endDate,
      overdue,
      sort = 'due_date',
      order = 'asc',
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = supabase
      .from('reminders')
      .select(
        `
        *,
        contacts(id, name, company, phone)
      `,
        { count: 'exact' }
      )
      .eq('user_id', userId);

    // Apply filters
    if (status) {
      query = query.eq('status', status);
    }
    if (type) {
      query = query.eq('type', type);
    }
    if (priority) {
      query = query.eq('priority', priority);
    }
    if (contact_id) {
      query = query.eq('contact_id', contact_id);
    }
    if (startDate) {
      query = query.gte('due_date', startDate);
    }
    if (endDate) {
      query = query.lte('due_date', endDate);
    }
    if (overdue === 'true') {
      query = query
        .lt('due_date', new Date().toISOString())
        .eq('status', 'pending');
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
        reminders: data,
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
    console.error('List reminders error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch reminders',
      },
    });
  }
});

/**
 * GET /api/reminders/today
 * Get today's reminders
 */
router.get('/today', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get start and end of today in user's timezone (default to MYT)
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayEnd = new Date(todayStart);
    todayEnd.setDate(todayEnd.getDate() + 1);

    const { data, error } = await supabase
      .from('reminders')
      .select(
        `
        *,
        contacts(id, name, company, phone)
      `
      )
      .eq('user_id', userId)
      .eq('status', 'pending')
      .gte('due_date', todayStart.toISOString())
      .lt('due_date', todayEnd.toISOString())
      .order('due_date', { ascending: true });

    if (error) {
      throw error;
    }

    return res.status(200).json({
      success: true,
      data: {
        reminders: data,
        count: data.length,
        date: todayStart.toISOString().split('T')[0],
      },
      error: null,
    });
  } catch (err) {
    console.error("Today's reminders error:", err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: "Failed to fetch today's reminders",
      },
    });
  }
});

/**
 * GET /api/reminders/upcoming
 * Get upcoming reminders (next 7 days)
 */
router.get('/upcoming', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { days = 7 } = req.query;

    const now = new Date();
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + parseInt(days));

    const { data, error } = await supabase
      .from('reminders')
      .select(
        `
        *,
        contacts(id, name, company, phone)
      `
      )
      .eq('user_id', userId)
      .eq('status', 'pending')
      .gte('due_date', now.toISOString())
      .lte('due_date', futureDate.toISOString())
      .order('due_date', { ascending: true });

    if (error) {
      throw error;
    }

    // Group by date
    const grouped = data.reduce((acc, reminder) => {
      const date = reminder.due_date.split('T')[0];
      if (!acc[date]) {
        acc[date] = [];
      }
      acc[date].push(reminder);
      return acc;
    }, {});

    return res.status(200).json({
      success: true,
      data: {
        reminders: data,
        grouped,
        count: data.length,
        days: parseInt(days),
      },
      error: null,
    });
  } catch (err) {
    console.error('Upcoming reminders error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch upcoming reminders',
      },
    });
  }
});

/**
 * GET /api/reminders/overdue
 * Get overdue reminders
 */
router.get('/overdue', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data, error } = await supabase
      .from('reminders')
      .select(
        `
        *,
        contacts(id, name, company, phone)
      `
      )
      .eq('user_id', userId)
      .eq('status', 'pending')
      .lt('due_date', new Date().toISOString())
      .order('due_date', { ascending: true });

    if (error) {
      throw error;
    }

    return res.status(200).json({
      success: true,
      data: {
        reminders: data,
        count: data.length,
      },
      error: null,
    });
  } catch (err) {
    console.error('Overdue reminders error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch overdue reminders',
      },
    });
  }
});

/**
 * GET /api/reminders/stats
 * Get reminder statistics
 */
router.get('/stats', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get all reminders
    const { data: reminders } = await supabase
      .from('reminders')
      .select('status, type, priority, due_date')
      .eq('user_id', userId);

    if (!reminders) {
      return res.status(200).json({
        success: true,
        data: {
          total: 0,
          pending: 0,
          completed: 0,
          overdue: 0,
          byType: {},
          byPriority: {},
        },
        error: null,
      });
    }

    const now = new Date();

    // Calculate stats
    const stats = reminders.reduce(
      (acc, r) => {
        acc.total += 1;
        acc.byStatus[r.status] = (acc.byStatus[r.status] || 0) + 1;
        acc.byType[r.type] = (acc.byType[r.type] || 0) + 1;
        acc.byPriority[r.priority] = (acc.byPriority[r.priority] || 0) + 1;

        if (r.status === 'pending' && new Date(r.due_date) < now) {
          acc.overdue += 1;
        }

        return acc;
      },
      {
        total: 0,
        overdue: 0,
        byStatus: {},
        byType: {},
        byPriority: {},
      }
    );

    return res.status(200).json({
      success: true,
      data: {
        total: stats.total,
        pending: stats.byStatus.pending || 0,
        completed: stats.byStatus.completed || 0,
        overdue: stats.overdue,
        byStatus: stats.byStatus,
        byType: stats.byType,
        byPriority: stats.byPriority,
        completionRate:
          stats.total > 0
            ? Math.round(((stats.byStatus.completed || 0) / stats.total) * 100)
            : 0,
      },
      error: null,
    });
  } catch (err) {
    console.error('Reminder stats error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to get reminder statistics',
      },
    });
  }
});

/**
 * GET /api/reminders/:id
 * Get single reminder
 */
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const { data, error } = await supabase
      .from('reminders')
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
            message: 'Reminder not found',
          },
        });
      }
      throw error;
    }

    return res.status(200).json({
      success: true,
      data: {
        reminder: data,
      },
      error: null,
    });
  } catch (err) {
    console.error('Get reminder error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch reminder',
      },
    });
  }
});

/**
 * POST /api/reminders
 * Create new reminder
 */
router.post('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      title,
      description,
      contact_id,
      due_date,
      due_time,
      type,
      priority,
      recurrence,
      notification_minutes,
    } = req.body;

    // Validate input
    const validationErrors = validateReminder({ title, due_date, type, priority });
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

    // Verify contact if provided
    if (contact_id) {
      const { data: contact } = await supabase
        .from('contacts')
        .select('id')
        .eq('id', contact_id)
        .eq('user_id', userId)
        .single();

      if (!contact) {
        return res.status(404).json({
          success: false,
          data: null,
          error: {
            code: 'CONTACT_NOT_FOUND',
            message: 'Contact not found',
          },
        });
      }
    }

    // Combine date and time
    let fullDueDate = due_date;
    if (due_time) {
      fullDueDate = `${due_date.split('T')[0]}T${due_time}:00`;
    }

    // Create reminder
    const { data, error } = await supabase
      .from('reminders')
      .insert({
        user_id: userId,
        title: title.trim(),
        description: description?.trim() || null,
        contact_id: contact_id || null,
        due_date: fullDueDate,
        type: type || 'task',
        priority: priority || 'medium',
        status: 'pending',
        recurrence: recurrence || null,
        notification_minutes: notification_minutes || 30,
      })
      .select()
      .single();

    if (error) {
      throw error;
    }

    return res.status(201).json({
      success: true,
      data: {
        reminder: data,
      },
      error: null,
    });
  } catch (err) {
    console.error('Create reminder error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to create reminder',
      },
    });
  }
});

/**
 * PUT /api/reminders/:id
 * Update reminder
 */
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const updates = req.body;

    // Validate updates
    if (updates.type && !REMINDER_TYPES.includes(updates.type)) {
      return res.status(400).json({
        success: false,
        data: null,
        error: {
          code: 'INVALID_TYPE',
          message: `Type must be one of: ${REMINDER_TYPES.join(', ')}`,
        },
      });
    }

    if (updates.priority && !PRIORITIES.includes(updates.priority)) {
      return res.status(400).json({
        success: false,
        data: null,
        error: {
          code: 'INVALID_PRIORITY',
          message: `Priority must be one of: ${PRIORITIES.join(', ')}`,
        },
      });
    }

    // Remove fields that shouldn't be updated
    delete updates.id;
    delete updates.user_id;
    delete updates.created_at;

    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('reminders')
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
            message: 'Reminder not found',
          },
        });
      }
      throw error;
    }

    return res.status(200).json({
      success: true,
      data: {
        reminder: data,
      },
      error: null,
    });
  } catch (err) {
    console.error('Update reminder error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to update reminder',
      },
    });
  }
});

/**
 * PUT /api/reminders/:id/complete
 * Mark reminder as complete
 */
router.put('/:id/complete', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const { notes } = req.body;

    const updates = {
      status: 'completed',
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    if (notes) {
      updates.completion_notes = notes;
    }

    const { data, error } = await supabase
      .from('reminders')
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
            message: 'Reminder not found',
          },
        });
      }
      throw error;
    }

    // Handle recurrence - create next reminder if recurring
    if (data.recurrence) {
      const nextDue = calculateNextRecurrence(data.due_date, data.recurrence);
      if (nextDue) {
        await supabase.from('reminders').insert({
          user_id: userId,
          title: data.title,
          description: data.description,
          contact_id: data.contact_id,
          due_date: nextDue,
          type: data.type,
          priority: data.priority,
          status: 'pending',
          recurrence: data.recurrence,
          notification_minutes: data.notification_minutes,
        });
      }
    }

    return res.status(200).json({
      success: true,
      data: {
        reminder: data,
      },
      error: null,
    });
  } catch (err) {
    console.error('Complete reminder error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to complete reminder',
      },
    });
  }
});

/**
 * PUT /api/reminders/:id/snooze
 * Snooze reminder
 */
router.put('/:id/snooze', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const { minutes = 30, until } = req.body;

    let newDueDate;
    if (until) {
      newDueDate = new Date(until);
    } else {
      newDueDate = new Date();
      newDueDate.setMinutes(newDueDate.getMinutes() + parseInt(minutes));
    }

    const { data, error } = await supabase
      .from('reminders')
      .update({
        due_date: newDueDate.toISOString(),
        snoozed_count: supabase.sql`COALESCE(snoozed_count, 0) + 1`,
        last_snoozed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) {
      throw error;
    }

    return res.status(200).json({
      success: true,
      data: {
        reminder: data,
        newDueDate: newDueDate.toISOString(),
      },
      error: null,
    });
  } catch (err) {
    console.error('Snooze reminder error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to snooze reminder',
      },
    });
  }
});

/**
 * DELETE /api/reminders/:id
 * Delete reminder
 */
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const { error } = await supabase
      .from('reminders')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);

    if (error) {
      throw error;
    }

    return res.status(200).json({
      success: true,
      data: {
        message: 'Reminder deleted successfully',
        id: id,
      },
      error: null,
    });
  } catch (err) {
    console.error('Delete reminder error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to delete reminder',
      },
    });
  }
});

/**
 * Calculate next recurrence date
 */
function calculateNextRecurrence(currentDate, recurrence) {
  const date = new Date(currentDate);

  switch (recurrence) {
    case 'daily':
      date.setDate(date.getDate() + 1);
      break;
    case 'weekly':
      date.setDate(date.getDate() + 7);
      break;
    case 'biweekly':
      date.setDate(date.getDate() + 14);
      break;
    case 'monthly':
      date.setMonth(date.getMonth() + 1);
      break;
    case 'quarterly':
      date.setMonth(date.getMonth() + 3);
      break;
    case 'yearly':
      date.setFullYear(date.getFullYear() + 1);
      break;
    default:
      return null;
  }

  return date.toISOString();
}

module.exports = router;
