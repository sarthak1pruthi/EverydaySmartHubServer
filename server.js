/**
 * Everyday Tasks Hub - Express Backend Server
 * 
 * This server manages the hub state for users and provides REST API endpoints
 * for both the frontend website and Alexa skill to interact with.
 * 
 * TODO: Replace in-memory storage with a real database (MongoDB, PostgreSQL, etc.)
 */

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(express.json());
app.use(cors()); // Open CORS for local development - TODO: Restrict in production

// =============================================================================
// IN-MEMORY DATA STORE
// TODO: Replace this with a real database connection (MongoDB, PostgreSQL, etc.)
// =============================================================================

/**
 * Hub state storage by visitorId (short ID for easier tracking)
 * Structure: { [visitorId]: HubState }
 */
const hubStateByVisitorId = {};

/**
 * Maps Alexa userId to our shorter visitorId
 * Structure: { [alexaUserId]: visitorId }
 */
const alexaUserToVisitor = {};

/**
 * Counter for generating visitor IDs
 */
let visitorCounter = 0;

/**
 * Registered profiles that users have created via Alexa
 * Structure: { [visitorId]: { name, avatar, createdAt, lastSeen } }
 */
const registeredProfiles = {};

/**
 * Voice history storage - tracks all Alexa interactions
 * Structure: { [visitorId]: [{ id, timestamp, intent, utterance, response, category }] }
 */
const voiceHistoryByVisitor = {};

/**
 * Maximum number of history entries to keep per user
 */
const MAX_HISTORY_ENTRIES = 100;

/**
 * Predefined tasks for the Everyday Tasks Hub
 */
const DEFAULT_TASKS = [
  { id: 't1', title: 'Morning Routine', icon: '☀️', description: 'Start your day right', category: 'routine', voiceCommand: 'start my morning routine' },
  { id: 't2', title: 'Grocery List', icon: '🛒', description: 'Manage shopping items', category: 'list', voiceCommand: 'open my grocery list' },
  { id: 't3', title: 'Medication Reminder', icon: '💊', description: 'Never miss a dose', category: 'health', voiceCommand: 'set medication reminder' },
  { id: 't4', title: 'Control Lights', icon: '💡', description: 'Smart home controls', category: 'home', voiceCommand: 'turn off the lights' },
  { id: 't5', title: 'Privacy Dashboard', icon: '🛡️', description: 'Manage your data', category: 'privacy', voiceCommand: 'show privacy settings' },
  { id: 't6', title: 'Evening Routine', icon: '🌙', description: 'Wind down for the night', category: 'routine', voiceCommand: 'start evening routine' },
];

/**
 * Gets or creates a visitor ID for an Alexa user
 * @param {string} alexaUserId - The Alexa user ID
 * @returns {string} Visitor ID
 */
function getVisitorId(alexaUserId) {
  // For demo/web users, use the ID directly
  if (!alexaUserId.startsWith('amzn1.')) {
    return alexaUserId;
  }
  
  // For Alexa users, map to a shorter visitor ID
  if (!alexaUserToVisitor[alexaUserId]) {
    visitorCounter++;
    alexaUserToVisitor[alexaUserId] = `alexa-user-${visitorCounter}`;
  }
  return alexaUserToVisitor[alexaUserId];
}

/**
 * Creates a default hub state for a new user
 * @param {string} visitorId - The visitor's unique identifier
 * @returns {Object} Default hub state object
 */
function createDefaultHubState(visitorId) {
  return {
    visitorId: visitorId,
    odisplayName: null, // Set by user via Alexa: "call me Mom"
    activeTile: 'home',
    lastAction: 'NONE',
    profile: 'default',
    routineResult: {
      lights: null,
      thermostat: null,
      reminder: null
    },
    groceryList: [],
    pendingItem: null,
    privacy: {
      microphoneEnabled: true,
      allowVoiceHistory: true,
      lastHistoryDelete: null
    },
    voiceHistory: [], // Recent voice commands (synced from voiceHistoryByVisitor)
    tasks: [...DEFAULT_TASKS], // Copy of default tasks
    customTasks: [], // User-added tasks
    debugInfo: {
      lastUpdated: new Date().toISOString(),
      lastAlexaRequest: null,
      isAlexaUser: visitorId.startsWith('alexa-user-')
    }
  };
}

/**
 * Gets or creates hub state for a visitor
 * @param {string} visitorId - The visitor's unique identifier
 * @returns {Object} The visitor's hub state
 */
function getOrCreateHubState(visitorId) {
  if (!hubStateByVisitorId[visitorId]) {
    hubStateByVisitorId[visitorId] = createDefaultHubState(visitorId);
    console.log(`[Hub] Created new hub state for visitor: ${visitorId}`);
  }
  return hubStateByVisitorId[visitorId];
}

/**
 * Deep merges partial state into existing state
 */
function deepMerge(target, source) {
  const result = { ...target };
  
  for (const key in source) {
    if (source[key] !== undefined) {
      if (
        source[key] !== null &&
        typeof source[key] === 'object' &&
        !Array.isArray(source[key]) &&
        target[key] !== null &&
        typeof target[key] === 'object' &&
        !Array.isArray(target[key])
      ) {
        result[key] = deepMerge(target[key], source[key]);
      } else {
        result[key] = source[key];
      }
    }
  }
  
  return result;
}

// =============================================================================
// REST API ROUTES
// =============================================================================

/**
 * POST /hub/state
 * Purpose: Called by Alexa Lambda (or simulator) to update the hub state
 * 
 * Request Body:
 * {
 *   "userId": "string",      // Can be Alexa userId or simple visitorId
 *   "state": { ... },        // Partial state to merge
 *   "displayName": "string"  // Optional: Name to show in UI (e.g., "Mom")
 * }
 */
app.post('/hub/state', (req, res) => {
  try {
    const { userId, state, displayName } = req.body;

    if (!userId) {
      return res.status(400).json({ 
        ok: false, 
        error: 'userId is required' 
      });
    }

    // Convert Alexa userId to our visitorId
    const visitorId = getVisitorId(userId);

    // Get or create existing state
    const existingState = getOrCreateHubState(visitorId);

    // Merge incoming state with existing state
    const updatedState = deepMerge(existingState, state || {});
    
    // Update display name if provided (from "Alexa, call me Mom")
    if (displayName) {
      updatedState.displayName = displayName;
      
      // Register/update the profile
      registeredProfiles[visitorId] = {
        name: displayName,
        avatar: getAvatarForName(displayName),
        createdAt: registeredProfiles[visitorId]?.createdAt || new Date().toISOString(),
        lastSeen: new Date().toISOString()
      };
    }
    
    // Update timestamp and debug info
    updatedState.debugInfo = updatedState.debugInfo || {};
    updatedState.debugInfo.lastUpdated = new Date().toISOString();
    updatedState.debugInfo.isAlexaUser = userId.startsWith('amzn1.');
    updatedState.debugInfo.originalAlexaId = userId.startsWith('amzn1.') ? userId.substring(0, 30) + '...' : null;

    // Record voice history if this is an Alexa request and history is enabled
    if (userId.startsWith('amzn1.') && updatedState.privacy?.allowVoiceHistory !== false) {
      const historyEntry = {
        id: `vh-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        timestamp: new Date().toISOString(),
        intent: state?.lastAction || 'UNKNOWN',
        utterance: state?.lastUtterance || getUtteranceForAction(state?.lastAction),
        response: state?.lastResponse || null,
        category: getCategoryForAction(state?.lastAction),
        activeTile: state?.activeTile || updatedState.activeTile
      };
      
      // Initialize history array if needed
      if (!voiceHistoryByVisitor[visitorId]) {
        voiceHistoryByVisitor[visitorId] = [];
      }
      
      // Add to beginning (most recent first)
      voiceHistoryByVisitor[visitorId].unshift(historyEntry);
      
      // Trim to max entries
      if (voiceHistoryByVisitor[visitorId].length > MAX_HISTORY_ENTRIES) {
        voiceHistoryByVisitor[visitorId] = voiceHistoryByVisitor[visitorId].slice(0, MAX_HISTORY_ENTRIES);
      }
      
      // Sync recent history to hub state (last 10 entries for UI)
      updatedState.voiceHistory = voiceHistoryByVisitor[visitorId].slice(0, 10);
      
      console.log(`[Hub] Recorded voice history: ${historyEntry.intent}`);
    }

    // Store updated state
    hubStateByVisitorId[visitorId] = updatedState;

    // Update last seen for registered profile
    if (registeredProfiles[visitorId]) {
      registeredProfiles[visitorId].lastSeen = new Date().toISOString();
    }

    console.log(`[Hub] Updated state for visitor: ${visitorId}`);
    console.log(`[Hub] Active tile: ${updatedState.activeTile}, Last action: ${updatedState.lastAction}`);

    return res.json({ 
      ok: true, 
      state: updatedState,
      visitorId: visitorId
    });

  } catch (error) {
    console.error('[Hub] Error updating state:', error);
    return res.status(500).json({ 
      ok: false, 
      error: 'Internal server error' 
    });
  }
});

/**
 * GET /hub/state/:userId
 * Purpose: Called by the frontend website to get current hub state
 */
app.get('/hub/state/:userId', (req, res) => {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({ 
        ok: false, 
        error: 'userId is required' 
      });
    }

    const visitorId = getVisitorId(userId);
    const hubState = getOrCreateHubState(visitorId);

    // Only log for Alexa users to reduce noise from frontend polling
    if (visitorId.startsWith('alexa-user-')) {
      console.log(`[Hub] Fetched state for Alexa visitor: ${visitorId}`);
    }

    return res.json(hubState);

  } catch (error) {
    console.error('[Hub] Error fetching state:', error);
    return res.status(500).json({ 
      ok: false, 
      error: 'Internal server error' 
    });
  }
});

/**
 * GET /hub/profiles
 * Purpose: Get all registered profiles (users who have used the Alexa skill)
 * This is used by the frontend to show only real users
 */
app.get('/hub/profiles', (req, res) => {
  try {
    const profiles = Object.entries(registeredProfiles).map(([visitorId, profile]) => ({
      visitorId,
      ...profile,
      state: hubStateByVisitorId[visitorId] || null
    }));

    // Sort by last seen (most recent first)
    profiles.sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));

    return res.json({
      count: profiles.length,
      profiles: profiles
    });

  } catch (error) {
    console.error('[Hub] Error fetching profiles:', error);
    return res.status(500).json({ 
      ok: false, 
      error: 'Internal server error' 
    });
  }
});

/**
 * POST /hub/profile/register
 * Purpose: Register a new profile (called when user says "Alexa, call me Mom")
 */
app.post('/hub/profile/register', (req, res) => {
  try {
    const { userId, name } = req.body;

    if (!userId || !name) {
      return res.status(400).json({ 
        ok: false, 
        error: 'userId and name are required' 
      });
    }

    const visitorId = getVisitorId(userId);

    registeredProfiles[visitorId] = {
      name: name,
      avatar: getAvatarForName(name),
      createdAt: registeredProfiles[visitorId]?.createdAt || new Date().toISOString(),
      lastSeen: new Date().toISOString()
    };

    // Update the hub state with display name
    const hubState = getOrCreateHubState(visitorId);
    hubState.displayName = name;
    hubState.profile = name.toLowerCase();
    hubStateByVisitorId[visitorId] = hubState;

    console.log(`[Hub] Registered profile: ${name} for visitor: ${visitorId}`);

    return res.json({
      ok: true,
      profile: registeredProfiles[visitorId],
      visitorId: visitorId
    });

  } catch (error) {
    console.error('[Hub] Error registering profile:', error);
    return res.status(500).json({ 
      ok: false, 
      error: 'Internal server error' 
    });
  }
});

/**
 * GET /hub/tasks
 * Purpose: Get the default task definitions for the hub
 */
app.get('/hub/tasks', (req, res) => {
  return res.json({
    tasks: DEFAULT_TASKS
  });
});

/**
 * POST /hub/reset
 * Purpose: Reset state for demo purposes
 */
app.post('/hub/reset', (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ 
        ok: false, 
        error: 'userId is required' 
      });
    }

    const visitorId = getVisitorId(userId);
    const freshState = createDefaultHubState(visitorId);
    hubStateByVisitorId[visitorId] = freshState;

    console.log(`[Hub] Reset state for visitor: ${visitorId}`);

    return res.json({ 
      ok: true, 
      state: freshState 
    });

  } catch (error) {
    console.error('[Hub] Error resetting state:', error);
    return res.status(500).json({ 
      ok: false, 
      error: 'Internal server error' 
    });
  }
});

/**
 * GET /hub/users
 * Purpose: Debug endpoint to see all users
 */
app.get('/hub/users', (req, res) => {
  const visitorIds = Object.keys(hubStateByVisitorId);
  return res.json({ 
    count: visitorIds.length, 
    visitorIds: visitorIds,
    profiles: registeredProfiles,
    alexaMappings: alexaUserToVisitor
  });
});

// =============================================================================
// GROCERY LIST ROUTES
// =============================================================================

/**
 * GET /hub/grocery/all
 * Purpose: Get grocery list items from ALL users (for demo dashboard)
 * Aggregates grocery items from all Alexa users
 */
app.get('/hub/grocery/all', (req, res) => {
  try {
    const allGroceryItems = [];
    
    // Collect grocery items from all visitors
    for (const [visitorId, state] of Object.entries(hubStateByVisitorId)) {
      const groceryList = state.groceryList || [];
      const pendingItem = state.pendingItem || null;
      const profile = registeredProfiles[visitorId];
      
      // Add each grocery item with user info
      groceryList.forEach((item, index) => {
        allGroceryItems.push({
          id: `${visitorId}-${index}`,
          item: item,
          visitorId: visitorId,
          userName: profile?.name || visitorId,
          addedAt: state.debugInfo?.lastUpdated || new Date().toISOString()
        });
      });
      
      // Add pending item if exists
      if (pendingItem) {
        allGroceryItems.push({
          id: `${visitorId}-pending`,
          item: pendingItem,
          visitorId: visitorId,
          userName: profile?.name || visitorId,
          isPending: true,
          addedAt: state.debugInfo?.lastUpdated || new Date().toISOString()
        });
      }
    }

    console.log(`[Hub] Fetched all grocery items: ${allGroceryItems.length} items from ${Object.keys(hubStateByVisitorId).length} users`);

    return res.json({
      ok: true,
      items: allGroceryItems,
      totalItems: allGroceryItems.length,
      userCount: Object.keys(hubStateByVisitorId).length
    });

  } catch (error) {
    console.error('[Hub] Error fetching all grocery items:', error);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

/**
 * DELETE /hub/grocery/all
 * Purpose: Clear grocery list from ALL users
 */
app.delete('/hub/grocery/all', (req, res) => {
  try {
    let totalCleared = 0;
    const clearedFrom = [];
    
    for (const visitorId of Object.keys(hubStateByVisitorId)) {
      const state = hubStateByVisitorId[visitorId];
      const count = (state.groceryList || []).length + (state.pendingItem ? 1 : 0);
      
      if (count > 0) {
        totalCleared += count;
        clearedFrom.push(visitorId);
      }
      
      state.groceryList = [];
      state.pendingItem = null;
    }

    console.log(`[Hub] Cleared ALL grocery lists: ${totalCleared} items from ${clearedFrom.length} users`);

    return res.json({
      ok: true,
      message: `Cleared ${totalCleared} items from ${clearedFrom.length} users`,
      totalCleared,
      usersAffected: clearedFrom
    });

  } catch (error) {
    console.error('[Hub] Error clearing all grocery lists:', error);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// =============================================================================
// VOICE HISTORY ROUTES
// =============================================================================

/**
 * GET /hub/history/all
 * Purpose: Get voice history from ALL Alexa users (for demo dashboard)
 */
app.get('/hub/history/all', (req, res) => {
  try {
    const { limit = 50 } = req.query;
    
    // Collect history from all visitors
    let allHistory = [];
    
    for (const [visitorId, history] of Object.entries(voiceHistoryByVisitor)) {
      const profile = registeredProfiles[visitorId];
      const enrichedHistory = history.map(entry => ({
        ...entry,
        visitorId,
        userName: profile?.name || visitorId
      }));
      allHistory = allHistory.concat(enrichedHistory);
    }
    
    // Sort by timestamp (most recent first)
    allHistory.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    // Limit results
    allHistory = allHistory.slice(0, Number(limit));

    console.log(`[Hub] Fetched all voice history: ${allHistory.length} entries`);

    return res.json({
      ok: true,
      total: allHistory.length,
      history: allHistory
    });

  } catch (error) {
    console.error('[Hub] Error fetching all history:', error);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

/**
 * DELETE /hub/history/all
 * Purpose: Delete voice history from ALL users (for demo dashboard)
 */
app.delete('/hub/history/all', (req, res) => {
  try {
    let totalDeleted = 0;
    const deletedFrom = [];
    
    // Clear history from all visitors
    for (const visitorId of Object.keys(voiceHistoryByVisitor)) {
      const count = voiceHistoryByVisitor[visitorId].length;
      if (count > 0) {
        totalDeleted += count;
        deletedFrom.push(visitorId);
      }
      voiceHistoryByVisitor[visitorId] = [];
      
      // Also update hub state
      if (hubStateByVisitorId[visitorId]) {
        hubStateByVisitorId[visitorId].voiceHistory = [];
        hubStateByVisitorId[visitorId].privacy = hubStateByVisitorId[visitorId].privacy || {};
        hubStateByVisitorId[visitorId].privacy.lastHistoryDelete = new Date().toISOString();
      }
    }

    console.log(`[Hub] Deleted ALL voice history: ${totalDeleted} entries from ${deletedFrom.length} users`);
    console.log(`[Hub] Users affected: ${deletedFrom.join(', ') || 'none'}`);

    return res.json({
      ok: true,
      message: `Deleted ${totalDeleted} history entries from ${deletedFrom.length} users`,
      totalDeleted,
      usersAffected: deletedFrom,
      deletedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('[Hub] Error deleting all history:', error);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

/**
 * GET /hub/history/:userId
 * Purpose: Get full voice history for a user
 */
app.get('/hub/history/:userId', (req, res) => {
  try {
    const { userId } = req.params;
    const { limit = 50, offset = 0 } = req.query;

    if (!userId) {
      return res.status(400).json({ ok: false, error: 'userId is required' });
    }

    const visitorId = getVisitorId(userId);
    const history = voiceHistoryByVisitor[visitorId] || [];
    const hubState = hubStateByVisitorId[visitorId];
    
    // Check if user has disabled history
    if (hubState?.privacy?.allowVoiceHistory === false) {
      return res.json({
        ok: true,
        historyEnabled: false,
        message: 'Voice history is disabled for this user',
        history: [],
        total: 0
      });
    }

    const paginatedHistory = history.slice(Number(offset), Number(offset) + Number(limit));

    return res.json({
      ok: true,
      historyEnabled: true,
      visitorId,
      total: history.length,
      limit: Number(limit),
      offset: Number(offset),
      history: paginatedHistory
    });

  } catch (error) {
    console.error('[Hub] Error fetching history:', error);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

/**
 * DELETE /hub/history/:userId
 * Purpose: Delete all voice history for a user
 */
app.delete('/hub/history/:userId', (req, res) => {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({ ok: false, error: 'userId is required' });
    }

    const visitorId = getVisitorId(userId);
    
    // Clear history
    voiceHistoryByVisitor[visitorId] = [];
    
    // Update hub state
    if (hubStateByVisitorId[visitorId]) {
      hubStateByVisitorId[visitorId].voiceHistory = [];
      hubStateByVisitorId[visitorId].privacy.lastHistoryDelete = new Date().toISOString();
    }

    console.log(`[Hub] Deleted voice history for visitor: ${visitorId}`);

    return res.json({
      ok: true,
      message: 'Voice history deleted successfully',
      deletedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('[Hub] Error deleting history:', error);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

/**
 * DELETE /hub/history/:userId/:entryId
 * Purpose: Delete a specific history entry
 */
app.delete('/hub/history/:userId/:entryId', (req, res) => {
  try {
    const { userId, entryId } = req.params;

    if (!userId || !entryId) {
      return res.status(400).json({ ok: false, error: 'userId and entryId are required' });
    }

    const visitorId = getVisitorId(userId);
    
    if (!voiceHistoryByVisitor[visitorId]) {
      return res.status(404).json({ ok: false, error: 'No history found for user' });
    }

    const initialLength = voiceHistoryByVisitor[visitorId].length;
    voiceHistoryByVisitor[visitorId] = voiceHistoryByVisitor[visitorId].filter(entry => entry.id !== entryId);
    
    if (voiceHistoryByVisitor[visitorId].length === initialLength) {
      return res.status(404).json({ ok: false, error: 'History entry not found' });
    }

    // Update hub state with recent history
    if (hubStateByVisitorId[visitorId]) {
      hubStateByVisitorId[visitorId].voiceHistory = voiceHistoryByVisitor[visitorId].slice(0, 10);
    }

    console.log(`[Hub] Deleted history entry ${entryId} for visitor: ${visitorId}`);

    return res.json({
      ok: true,
      message: 'History entry deleted successfully'
    });

  } catch (error) {
    console.error('[Hub] Error deleting history entry:', error);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

/**
 * POST /hub/history/toggle/:userId
 * Purpose: Enable or disable voice history recording
 */
app.post('/hub/history/toggle/:userId', (req, res) => {
  try {
    const { userId } = req.params;
    const { enabled } = req.body;

    if (!userId) {
      return res.status(400).json({ ok: false, error: 'userId is required' });
    }

    const visitorId = getVisitorId(userId);
    const hubState = getOrCreateHubState(visitorId);
    
    hubState.privacy = hubState.privacy || {};
    hubState.privacy.allowVoiceHistory = enabled !== false;
    
    // If disabling, optionally clear history
    if (enabled === false && req.body.clearHistory) {
      voiceHistoryByVisitor[visitorId] = [];
      hubState.voiceHistory = [];
      hubState.privacy.lastHistoryDelete = new Date().toISOString();
    }
    
    hubStateByVisitorId[visitorId] = hubState;

    console.log(`[Hub] Voice history ${enabled ? 'enabled' : 'disabled'} for visitor: ${visitorId}`);

    return res.json({
      ok: true,
      historyEnabled: hubState.privacy.allowVoiceHistory,
      message: `Voice history ${enabled ? 'enabled' : 'disabled'} successfully`
    });

  } catch (error) {
    console.error('[Hub] Error toggling history:', error);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Helper: Get utterance description for an action
 */
function getUtteranceForAction(action) {
  const utteranceMap = {
    'OPEN_HUB': '"Alexa, open everyday tasks hub"',
    'LAUNCH': '"Alexa, open everyday tasks hub"',
    'MORNING_ROUTINE': '"Start my morning routine"',
    'MORNING_ROUTINE_STARTED': '"Start my morning routine"',
    'EVENING_ROUTINE': '"Start my evening routine"',
    'EVENING_ROUTINE_STARTED': '"Start my evening routine"',
    'ADD_ITEM': '"Add [item] to grocery list"',
    'ADD_GROCERY_ITEM_REQUESTED': '"Add [item] to grocery list"',
    'ADD_GROCERY_ITEM_CONFIRMED': '"Yes" (confirmed adding item)',
    'CONFIRM_ITEM': '"Yes" (confirmed)',
    'VIEW_GROCERY_LIST': '"Show my grocery list"',
    'CLEAR_GROCERY_LIST': '"Clear grocery list"',
    'SHOW_PRIVACY': '"Show privacy settings"',
    'TOGGLE_MICROPHONE': '"Turn microphone off/on"',
    'TOGGLE_HISTORY': '"Toggle voice history"',
    'DELETE_HISTORY': '"Delete my voice history"',
    'LIGHTS_ON': '"Turn on the lights"',
    'LIGHTS_OFF': '"Turn off the lights"',
    'SET_PROFILE': '"Call me [name]"',
    'HELP': '"Help"',
    'STOP': '"Stop"',
    'CANCEL': '"Cancel"'
  };
  return utteranceMap[action] || `"${action || 'Voice command'}"`;
}

/**
 * Helper: Get category for an action
 */
function getCategoryForAction(action) {
  if (!action) return 'general';
  
  const categoryMap = {
    'OPEN_HUB': 'general',
    'MORNING_ROUTINE': 'routine',
    'MORNING_ROUTINE_STARTED': 'routine',
    'EVENING_ROUTINE': 'routine',
    'EVENING_ROUTINE_STARTED': 'routine',
    'ADD_ITEM': 'grocery',
    'ADD_GROCERY_ITEM_REQUESTED': 'grocery',
    'ADD_GROCERY_ITEM_CONFIRMED': 'grocery',
    'CONFIRM_ITEM': 'grocery',
    'VIEW_GROCERY_LIST': 'grocery',
    'CLEAR_GROCERY_LIST': 'grocery',
    'SHOW_PRIVACY': 'privacy',
    'TOGGLE_MICROPHONE': 'privacy',
    'TOGGLE_HISTORY': 'privacy',
    'DELETE_HISTORY': 'privacy',
    'LIGHTS_ON': 'home',
    'LIGHTS_OFF': 'home',
    'SET_PROFILE': 'profile',
    'LAUNCH': 'general',
    'HELP': 'general',
    'STOP': 'general',
    'CANCEL': 'general'
  };
  return categoryMap[action] || 'general';
}

/**
 * Helper: Get avatar emoji based on name
 */
function getAvatarForName(name) {
  const nameLower = name.toLowerCase();
  if (nameLower.includes('mom') || nameLower.includes('mother') || nameLower.includes('mama')) return '👩';
  if (nameLower.includes('dad') || nameLower.includes('father') || nameLower.includes('papa')) return '👨';
  if (nameLower.includes('kid') || nameLower.includes('child') || nameLower.includes('son')) return '👦';
  if (nameLower.includes('daughter') || nameLower.includes('girl')) return '👧';
  if (nameLower.includes('grandma') || nameLower.includes('grandmother')) return '👵';
  if (nameLower.includes('grandpa') || nameLower.includes('grandfather')) return '👴';
  if (nameLower.includes('student')) return '🧑‍🎓';
  return '👤';
}

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    service: 'Everyday Tasks Hub API',
    activeVisitors: Object.keys(hubStateByVisitorId).length,
    registeredProfiles: Object.keys(registeredProfiles).length
  });
});

// =============================================================================
// START SERVER
// =============================================================================

app.listen(PORT, () => {
  console.log('='.repeat(60));
  console.log('  Everyday Tasks Hub - Backend Server');
  console.log('='.repeat(60));
  console.log(`  Server running on http://localhost:${PORT}`);
  console.log('');
  console.log('  Available endpoints:');
  console.log(`    GET  /health              - Health check`);
  console.log(`    GET  /hub/state/:userId   - Get hub state for user`);
  console.log(`    POST /hub/state           - Update hub state`);
  console.log(`    POST /hub/reset           - Reset user's hub state`);
  console.log(`    GET  /hub/users           - List all users (debug)`);
  console.log('');
  console.log('  Voice History endpoints:');
  console.log(`    GET    /hub/history/all           - Get ALL users history`);
  console.log(`    GET    /hub/history/:userId        - Get voice history`);
  console.log(`    DELETE /hub/history/:userId        - Delete all history`);
  console.log(`    DELETE /hub/history/:userId/:id    - Delete single entry`);
  console.log(`    POST   /hub/history/toggle/:userId - Enable/disable history`);
  console.log('='.repeat(60));
});

module.exports = app; // Export for testing
