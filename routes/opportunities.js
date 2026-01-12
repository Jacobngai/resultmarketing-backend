/**
 * Opportunities (Deals) Routes
 * ResultMarketing CRM
 */

const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase');
const { authenticateToken } = require('../middleware/auth');

// Pipeline stages
const STAGES = [
  'lead',
  'qualified',
  'proposal',
  'negotiation',
  'closed_won',
  'closed_lost',
];

// Status types
const STATUSES = ['active', 'won', 'lost', 'on_hold'];

/**
 * Validate opportunity data
 */
function validateOpportunity(data) {
  const errors = [];

  if (!data.title || data.title.trim().length < 2) {
    errors.push('Title is required (minimum 2 characters)');
  }

  if (data.value !== undefined && (isNaN(data.value) || data.value < 0)) {
    errors.push('Value must be a positive number');
  }

  if (data.stage && !STAGES.includes(data.stage)) {
    errors.push(`Stage must be one of: ${STAGES.join(', ')}`);
  }

  if (data.status && !STATUSES.includes(data.status)) {
    errors.push(`Status must be one of: ${STATUSES.join(', ')}`);
  }

  if (data.probability !== undefined) {
    const prob = parseInt(data.probability);
    if (isNaN(prob) || prob < 0 || prob > 100) {
      errors.push('Probability must be between 0 and 100');
    }
  }

  return errors;
}

/**
 * GET /api/opportunities
 * List opportunities with filtering
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      page = 1,
      limit = 50,
      stage,
      status,
      contact_id,
      minValue,
      maxValue,
      sort = 'created_at',
      order = 'desc',
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = supabase
      .from('opportunities')
      .select(
        `
        *,
        contacts(id, name, company, phone)
      `,
        { count: 'exact' }
      )
      .eq('user_id', userId);

    // Apply filters
    if (stage) {
      query = query.eq('stage', stage);
    }
    if (status) {
      query = query.eq('status', status);
    }
    if (contact_id) {
      query = query.eq('contact_id', contact_id);
    }
    if (minValue) {
      query = query.gte('value', parseFloat(minValue));
    }
    if (maxValue) {
      query = query.lte('value', parseFloat(maxValue));
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
        opportunities: data,
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
    console.error('List opportunities error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch opportunities',
      },
    });
  }
});

/**
 * GET /api/opportunities/stats
 * Get pipeline statistics
 */
router.get('/stats', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get all active opportunities
    const { data: opportunities } = await supabase
      .from('opportunities')
      .select('stage, status, value, probability')
      .eq('user_id', userId);

    if (!opportunities) {
      return res.status(200).json({
        success: true,
        data: {
          total: 0,
          totalValue: 0,
          weightedValue: 0,
          byStage: {},
          byStatus: {},
          winRate: 0,
        },
        error: null,
      });
    }

    // Calculate stats by stage
    const stageStats = opportunities.reduce(
      (acc, opp) => {
        if (!acc.byStage[opp.stage]) {
          acc.byStage[opp.stage] = { count: 0, value: 0 };
        }
        acc.byStage[opp.stage].count += 1;
        acc.byStage[opp.stage].value += opp.value || 0;
        return acc;
      },
      { byStage: {} }
    );

    // Calculate stats by status
    const statusStats = opportunities.reduce((acc, opp) => {
      acc[opp.status] = (acc[opp.status] || 0) + 1;
      return acc;
    }, {});

    // Calculate totals
    const totalValue = opportunities.reduce((sum, opp) => sum + (opp.value || 0), 0);
    const weightedValue = opportunities
      .filter((opp) => opp.status === 'active')
      .reduce((sum, opp) => sum + (opp.value || 0) * ((opp.probability || 0) / 100), 0);

    // Calculate win rate
    const closedOpps = opportunities.filter(
      (opp) => opp.status === 'won' || opp.status === 'lost'
    );
    const wonOpps = opportunities.filter((opp) => opp.status === 'won');
    const winRate = closedOpps.length > 0
      ? (wonOpps.length / closedOpps.length) * 100
      : 0;

    // Get monthly trend (last 6 months)
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    const { data: monthlyData } = await supabase
      .from('opportunities')
      .select('created_at, value, status')
      .eq('user_id', userId)
      .gte('created_at', sixMonthsAgo.toISOString());

    const monthlyStats = monthlyData?.reduce((acc, opp) => {
      const month = opp.created_at.substring(0, 7);
      if (!acc[month]) {
        acc[month] = { created: 0, value: 0, won: 0 };
      }
      acc[month].created += 1;
      acc[month].value += opp.value || 0;
      if (opp.status === 'won') {
        acc[month].won += 1;
      }
      return acc;
    }, {});

    return res.status(200).json({
      success: true,
      data: {
        total: opportunities.length,
        totalValue,
        weightedValue,
        byStage: stageStats.byStage,
        byStatus: statusStats,
        winRate: Math.round(winRate * 100) / 100,
        monthlyTrend: monthlyStats || {},
        activeCount: statusStats.active || 0,
        averageValue: opportunities.length > 0 ? totalValue / opportunities.length : 0,
      },
      error: null,
    });
  } catch (err) {
    console.error('Pipeline stats error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to get pipeline statistics',
      },
    });
  }
});

/**
 * GET /api/opportunities/pipeline
 * Get opportunities organized by pipeline stage
 */
router.get('/pipeline', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data, error } = await supabase
      .from('opportunities')
      .select(
        `
        *,
        contacts(id, name, company)
      `
      )
      .eq('user_id', userId)
      .eq('status', 'active')
      .order('value', { ascending: false });

    if (error) {
      throw error;
    }

    // Organize by stage
    const pipeline = STAGES.reduce((acc, stage) => {
      acc[stage] = data?.filter((opp) => opp.stage === stage) || [];
      return acc;
    }, {});

    // Calculate stage totals
    const stageTotals = STAGES.reduce((acc, stage) => {
      const stageOpps = pipeline[stage];
      acc[stage] = {
        count: stageOpps.length,
        value: stageOpps.reduce((sum, opp) => sum + (opp.value || 0), 0),
      };
      return acc;
    }, {});

    return res.status(200).json({
      success: true,
      data: {
        pipeline,
        stageTotals,
        stages: STAGES,
      },
      error: null,
    });
  } catch (err) {
    console.error('Pipeline view error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to get pipeline view',
      },
    });
  }
});

/**
 * GET /api/opportunities/:id
 * Get single opportunity
 */
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const { data, error } = await supabase
      .from('opportunities')
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
            message: 'Opportunity not found',
          },
        });
      }
      throw error;
    }

    return res.status(200).json({
      success: true,
      data: {
        opportunity: data,
      },
      error: null,
    });
  } catch (err) {
    console.error('Get opportunity error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch opportunity',
      },
    });
  }
});

/**
 * POST /api/opportunities
 * Create new opportunity
 */
router.post('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      title,
      contact_id,
      value,
      currency,
      stage,
      status,
      probability,
      expected_close_date,
      description,
      products,
      notes,
    } = req.body;

    // Validate input
    const validationErrors = validateOpportunity({
      title,
      value,
      stage,
      status,
      probability,
    });
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

    // Create opportunity
    const { data, error } = await supabase
      .from('opportunities')
      .insert({
        user_id: userId,
        title: title.trim(),
        contact_id: contact_id || null,
        value: value || 0,
        currency: currency || 'MYR',
        stage: stage || 'lead',
        status: status || 'active',
        probability: probability || 0,
        expected_close_date: expected_close_date || null,
        description: description?.trim() || null,
        products: products || [],
        notes: notes?.trim() || null,
      })
      .select()
      .single();

    if (error) {
      throw error;
    }

    return res.status(201).json({
      success: true,
      data: {
        opportunity: data,
      },
      error: null,
    });
  } catch (err) {
    console.error('Create opportunity error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to create opportunity',
      },
    });
  }
});

/**
 * PUT /api/opportunities/:id
 * Update opportunity
 */
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const updates = req.body;

    // Validate updates
    const validationErrors = validateOpportunity(updates);
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

    // Get current opportunity for stage change tracking
    const { data: current } = await supabase
      .from('opportunities')
      .select('stage, status')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (!current) {
      return res.status(404).json({
        success: false,
        data: null,
        error: {
          code: 'NOT_FOUND',
          message: 'Opportunity not found',
        },
      });
    }

    // Remove fields that shouldn't be updated
    delete updates.id;
    delete updates.user_id;
    delete updates.created_at;

    updates.updated_at = new Date().toISOString();

    // Track stage change
    if (updates.stage && updates.stage !== current.stage) {
      updates.stage_changed_at = new Date().toISOString();
    }

    // Auto-update status based on stage
    if (updates.stage === 'closed_won') {
      updates.status = 'won';
      updates.probability = 100;
      updates.closed_at = new Date().toISOString();
    } else if (updates.stage === 'closed_lost') {
      updates.status = 'lost';
      updates.probability = 0;
      updates.closed_at = new Date().toISOString();
    }

    const { data, error } = await supabase
      .from('opportunities')
      .update(updates)
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
        opportunity: data,
        stageChanged: current.stage !== data.stage,
      },
      error: null,
    });
  } catch (err) {
    console.error('Update opportunity error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to update opportunity',
      },
    });
  }
});

/**
 * PUT /api/opportunities/:id/stage
 * Update opportunity stage (drag & drop in pipeline)
 */
router.put('/:id/stage', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const { stage } = req.body;

    if (!STAGES.includes(stage)) {
      return res.status(400).json({
        success: false,
        data: null,
        error: {
          code: 'INVALID_STAGE',
          message: `Stage must be one of: ${STAGES.join(', ')}`,
        },
      });
    }

    const updates = {
      stage,
      stage_changed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    // Auto-update status and probability
    if (stage === 'closed_won') {
      updates.status = 'won';
      updates.probability = 100;
      updates.closed_at = new Date().toISOString();
    } else if (stage === 'closed_lost') {
      updates.status = 'lost';
      updates.probability = 0;
      updates.closed_at = new Date().toISOString();
    } else {
      // Default probabilities by stage
      const stageProbabilities = {
        lead: 10,
        qualified: 25,
        proposal: 50,
        negotiation: 75,
      };
      updates.probability = stageProbabilities[stage] || updates.probability;
    }

    const { data, error } = await supabase
      .from('opportunities')
      .update(updates)
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
        opportunity: data,
      },
      error: null,
    });
  } catch (err) {
    console.error('Update stage error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to update stage',
      },
    });
  }
});

/**
 * DELETE /api/opportunities/:id
 * Delete opportunity
 */
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const { error } = await supabase
      .from('opportunities')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);

    if (error) {
      throw error;
    }

    return res.status(200).json({
      success: true,
      data: {
        message: 'Opportunity deleted successfully',
        id: id,
      },
      error: null,
    });
  } catch (err) {
    console.error('Delete opportunity error:', err);
    return res.status(500).json({
      success: false,
      data: null,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to delete opportunity',
      },
    });
  }
});

module.exports = router;
