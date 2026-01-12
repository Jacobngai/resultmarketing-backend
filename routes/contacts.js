/**
 * Contact Routes
 * ResultMarketing CRM
 */

const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase');
const { authenticateToken, checkContactLimit } = require('../middleware/auth');
const { contactCreationRateLimit, searchRateLimit } = require('../middleware/rateLimit');

/**
 * Validate contact data
 */
function validateContact(data) {
  const errors = [];

  if (!data.name || data.name.trim().length < 2) {
    errors.push('Name is required (minimum 2 characters)');
  }

  if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
    errors.push('Invalid email format');
  }

  if (data.phone && !/^[\d\s\-+()]{8,}$/.test(data.phone)) {
    errors.push('Invalid phone number format');
  }

  return errors;
}

/**
 * GET /api/contacts
 * List contacts with pagination and filtering
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      page = 1,
      limit = 50,
      sort = 'created_at',
      order = 'desc',
      category,
      industry,
      status,
      search,
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);

    // Build query
    let query = supabase
      .from('contacts')
      .select('*', { count: 'exact' })
      .eq('user_id', userId);

    // Apply filters
    if (category) {
      query = query.eq('category', category);
    }
    if (industry) {
      query = query.eq('industry', industry);
    }
    if (status) {
      query = query.eq('status', status);
    }
    if (search) {
      query = query.or(
        `name.ilike.%${search}%,company.ilike.%${search}%,email.ilike.%${search}%,phone.ilike.%${search}%`
      );
    }

    // Apply sorting
    const validSorts = ['created_at', 'updated_at', 'name', 'company', 'last_interaction'];
    const sortField = validSorts.includes(sort) ? sort : 'created_at';
    const ascending = order.toLowerCase() === 'asc';

    query = query
      .order(sortField, { ascending })
      .range(offset, offset + parseInt(limit) - 1);

    const { data, error, count } = await query;

    if (error) {
      throw error;
    }

    return res.status(200).json({
      success: true,
      data: {
        contacts: data,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: count,
          totalPages: Math.ceil(count / parseInt(limit)),
          hasMore: offset + data.length < count,
        },
      },
      error: null,
    });
  } catch (err) {
    console.error('List contacts error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch contacts',
      },
    });
  }
});

/**
 * GET /api/contacts/search
 * Search contacts with advanced filters
 */
router.get('/search', authenticateToken, searchRateLimit, async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      q,
      name,
      company,
      industry,
      category,
      phone,
      email,
      hasInteraction,
      createdAfter,
      createdBefore,
      limit = 20,
    } = req.query;

    let query = supabase
      .from('contacts')
      .select('*')
      .eq('user_id', userId);

    // Full text search
    if (q) {
      query = query.or(
        `name.ilike.%${q}%,company.ilike.%${q}%,email.ilike.%${q}%,phone.ilike.%${q}%,notes.ilike.%${q}%`
      );
    }

    // Specific field searches
    if (name) query = query.ilike('name', `%${name}%`);
    if (company) query = query.ilike('company', `%${company}%`);
    if (industry) query = query.eq('industry', industry);
    if (category) query = query.eq('category', category);
    if (phone) query = query.ilike('phone', `%${phone}%`);
    if (email) query = query.ilike('email', `%${email}%`);

    // Date filters
    if (createdAfter) {
      query = query.gte('created_at', createdAfter);
    }
    if (createdBefore) {
      query = query.lte('created_at', createdBefore);
    }

    // Interaction filter
    if (hasInteraction === 'true') {
      query = query.not('last_interaction', 'is', null);
    } else if (hasInteraction === 'false') {
      query = query.is('last_interaction', null);
    }

    query = query.limit(parseInt(limit));

    const { data, error } = await query;

    if (error) {
      throw error;
    }

    return res.status(200).json({
      success: true,
      data: {
        contacts: data,
        count: data.length,
      },
      error: null,
    });
  } catch (err) {
    console.error('Search contacts error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to search contacts',
      },
    });
  }
});

/**
 * GET /api/contacts/count
 * Get total contact count
 */
router.get('/count', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const { count, error } = await supabase
      .from('contacts')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);

    if (error) {
      throw error;
    }

    return res.status(200).json({
      success: true,
      data: {
        count: count,
      },
      error: null,
    });
  } catch (err) {
    console.error('Count contacts error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to count contacts',
      },
    });
  }
});

/**
 * GET /api/contacts/stats
 * Get contact statistics
 */
router.get('/stats', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get total count
    const { count: totalCount } = await supabase
      .from('contacts')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);

    // Get counts by category
    const { data: categoryData } = await supabase
      .from('contacts')
      .select('category')
      .eq('user_id', userId);

    const categoryStats = categoryData?.reduce((acc, item) => {
      const cat = item.category || 'Uncategorized';
      acc[cat] = (acc[cat] || 0) + 1;
      return acc;
    }, {});

    // Get counts by industry
    const { data: industryData } = await supabase
      .from('contacts')
      .select('industry')
      .eq('user_id', userId);

    const industryStats = industryData?.reduce((acc, item) => {
      const ind = item.industry || 'Unknown';
      acc[ind] = (acc[ind] || 0) + 1;
      return acc;
    }, {});

    // Get recent contacts (last 7 days)
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);

    const { count: recentCount } = await supabase
      .from('contacts')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('created_at', weekAgo.toISOString());

    // Get contacts needing follow-up (no interaction in 30 days)
    const monthAgo = new Date();
    monthAgo.setDate(monthAgo.getDate() - 30);

    const { count: needFollowUp } = await supabase
      .from('contacts')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .or(`last_interaction.lt.${monthAgo.toISOString()},last_interaction.is.null`);

    return res.status(200).json({
      success: true,
      data: {
        total: totalCount || 0,
        recentlyAdded: recentCount || 0,
        needFollowUp: needFollowUp || 0,
        byCategory: categoryStats || {},
        byIndustry: industryStats || {},
      },
      error: null,
    });
  } catch (err) {
    console.error('Contact stats error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to get contact statistics',
      },
    });
  }
});

/**
 * GET /api/contacts/:id
 * Get single contact by ID
 */
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const { data, error } = await supabase
      .from('contacts')
      .select('*')
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
            message: 'Contact not found',
          },
        });
      }
      throw error;
    }

    return res.status(200).json({
      success: true,
      data: {
        contact: data,
      },
      error: null,
    });
  } catch (err) {
    console.error('Get contact error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch contact',
      },
    });
  }
});

/**
 * POST /api/contacts
 * Create new contact
 */
router.post('/', authenticateToken, contactCreationRateLimit, checkContactLimit(), async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      name,
      email,
      phone,
      company,
      position,
      industry,
      category,
      address,
      notes,
      tags,
      custom_fields,
      source,
    } = req.body;

    // Validate required fields
    const validationErrors = validateContact({ name, email, phone });
    if (validationErrors.length > 0) {
      return res.status(400).json({
        success: false,
        data: null,
        error: {
          code: 'VALIDATION_ERROR',
          message: validationErrors.join(', '),
          details: validationErrors,
        },
      });
    }

    // Check for duplicates
    if (email || phone) {
      let duplicateQuery = supabase
        .from('contacts')
        .select('id, name, email, phone')
        .eq('user_id', userId);

      if (email) {
        duplicateQuery = duplicateQuery.or(`email.eq.${email}`);
      }
      if (phone) {
        const cleanPhone = phone.replace(/[^\d]/g, '');
        duplicateQuery = duplicateQuery.or(`phone.ilike.%${cleanPhone.slice(-8)}%`);
      }

      const { data: duplicates } = await duplicateQuery;

      if (duplicates && duplicates.length > 0) {
        return res.status(409).json({
          success: false,
          data: null,
          error: {
            code: 'DUPLICATE_CONTACT',
            message: 'A contact with this email or phone already exists',
            duplicates: duplicates.map((d) => ({
              id: d.id,
              name: d.name,
              email: d.email,
              phone: d.phone,
            })),
          },
        });
      }
    }

    // Create contact
    const { data, error } = await supabase
      .from('contacts')
      .insert({
        user_id: userId,
        name: name.trim(),
        email: email?.toLowerCase().trim() || null,
        phone: phone?.trim() || null,
        company: company?.trim() || null,
        position: position?.trim() || null,
        industry: industry || null,
        category: category || 'Lead',
        address: address?.trim() || null,
        notes: notes?.trim() || null,
        tags: tags || [],
        custom_fields: custom_fields || {},
        source: source || 'manual',
        status: 'active',
      })
      .select()
      .single();

    if (error) {
      throw error;
    }

    // Update contact count in profile
    await supabase.rpc('increment_contact_count', { user_id: userId });

    return res.status(201).json({
      success: true,
      data: {
        contact: data,
      },
      error: null,
    });
  } catch (err) {
    console.error('Create contact error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to create contact',
      },
    });
  }
});

/**
 * POST /api/contacts/bulk
 * Create multiple contacts at once
 */
router.post('/bulk', authenticateToken, checkContactLimit(), async (req, res) => {
  try {
    const userId = req.user.id;
    const { contacts } = req.body;

    if (!Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({
        success: false,
        data: null,
        error: {
          code: 'INVALID_INPUT',
          message: 'Contacts array is required',
        },
      });
    }

    // Limit bulk insert size
    if (contacts.length > 500) {
      return res.status(400).json({
        success: false,
        data: null,
        error: {
          code: 'TOO_MANY_CONTACTS',
          message: 'Maximum 500 contacts per bulk insert',
        },
      });
    }

    // Check contact limit
    const remaining = req.contactLimit?.remaining || 0;
    if (contacts.length > remaining) {
      return res.status(403).json({
        success: false,
        data: null,
        error: {
          code: 'CONTACT_LIMIT_EXCEEDED',
          message: `Can only add ${remaining} more contacts`,
        },
      });
    }

    // Prepare contacts
    const preparedContacts = contacts.map((c) => ({
      user_id: userId,
      name: c.name?.trim() || 'Unknown',
      email: c.email?.toLowerCase().trim() || null,
      phone: c.phone?.trim() || null,
      company: c.company?.trim() || null,
      position: c.position?.trim() || null,
      industry: c.industry || null,
      category: c.category || 'Lead',
      notes: c.notes?.trim() || null,
      tags: c.tags || [],
      source: c.source || 'bulk_import',
      status: 'active',
    }));

    // Insert contacts
    const { data, error } = await supabase
      .from('contacts')
      .insert(preparedContacts)
      .select();

    if (error) {
      throw error;
    }

    // Update contact count
    await supabase.rpc('increment_contact_count', {
      user_id: userId,
      amount: data.length,
    });

    return res.status(201).json({
      success: true,
      data: {
        created: data.length,
        contacts: data,
      },
      error: null,
    });
  } catch (err) {
    console.error('Bulk create error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to create contacts',
      },
    });
  }
});

/**
 * PUT /api/contacts/:id
 * Update existing contact
 */
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const updates = req.body;

    // Validate if name is being updated
    if (updates.name !== undefined) {
      const validationErrors = validateContact({ name: updates.name });
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
    }

    // Remove fields that shouldn't be updated directly
    delete updates.id;
    delete updates.user_id;
    delete updates.created_at;

    // Add updated_at timestamp
    updates.updated_at = new Date().toISOString();

    // Normalize email
    if (updates.email) {
      updates.email = updates.email.toLowerCase().trim();
    }

    const { data, error } = await supabase
      .from('contacts')
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
            message: 'Contact not found',
          },
        });
      }
      throw error;
    }

    return res.status(200).json({
      success: true,
      data: {
        contact: data,
      },
      error: null,
    });
  } catch (err) {
    console.error('Update contact error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to update contact',
      },
    });
  }
});

/**
 * DELETE /api/contacts/:id
 * Delete contact
 */
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    // Check if contact exists
    const { data: existing } = await supabase
      .from('contacts')
      .select('id')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (!existing) {
      return res.status(404).json({
        success: false,
        data: null,
        error: {
          code: 'NOT_FOUND',
          message: 'Contact not found',
        },
      });
    }

    // Delete related data first
    await supabase.from('interactions').delete().eq('contact_id', id);
    await supabase.from('reminders').delete().eq('contact_id', id);

    // Delete contact
    const { error } = await supabase
      .from('contacts')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);

    if (error) {
      throw error;
    }

    // Decrement contact count
    await supabase.rpc('decrement_contact_count', { user_id: userId });

    return res.status(200).json({
      success: true,
      data: {
        message: 'Contact deleted successfully',
        id: id,
      },
      error: null,
    });
  } catch (err) {
    console.error('Delete contact error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to delete contact',
      },
    });
  }
});

/**
 * GET /api/contacts/:id/interactions
 * Get interactions for a specific contact
 */
router.get('/:id/interactions', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const { limit = 20, offset = 0 } = req.query;

    // Verify contact ownership
    const { data: contact } = await supabase
      .from('contacts')
      .select('id')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (!contact) {
      return res.status(404).json({
        success: false,
        data: null,
        error: {
          code: 'NOT_FOUND',
          message: 'Contact not found',
        },
      });
    }

    const { data, error } = await supabase
      .from('interactions')
      .select('*')
      .eq('contact_id', id)
      .order('interaction_date', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

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
    console.error('Get contact interactions error:', err);
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

module.exports = router;
