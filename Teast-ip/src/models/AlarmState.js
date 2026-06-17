/**
 * Alarm State Codes
 * Integer-based alarm states for efficient storage and comparison
 */

const AlarmStateCodes = {
    INACTIVE: 0,      // Alarm condition not present
    ACTIVE: 1,        // Alarm active, not acknowledged
    ACTIVE_ACK: 2,    // Alarm active, acknowledged
    INACTIVE_ACK: 3,  // Alarm cleared but not acknowledged (needs ack to clear)
    ENDED: 4,         // Alarm ended (cleared and acknowledged)
    DISABLED: 5,      // Alarm disabled by user
};

const AlarmStateNames = {
    0: 'INACTIVE',
    1: 'ACTIVE',
    2: 'ACTIVE_ACK',
    3: 'INACTIVE_ACK',
    4: 'ENDED',
    5: 'DISABLED',
};

/**
 * Alarm severity levels
 */
const AlarmSeverity = {
    ALARM: 'alarm',
    WARNING: 'warning',
    ERROR: 'error',
    INFO: 'info',
};

/**
 * Alarm event types
 */
const AlarmEventType = {
    TRIGGERED: 'TRIGGERED',
    ENDED: 'ENDED',
    ACKNOWLEDGED: 'ACKNOWLEDGED',
    DISABLED: 'DISABLED',
    ENABLED: 'ENABLED',
};

/**
 * Limit comparison modes
 */
const LimitMode = {
    EQUAL: 'Equal',
    GREATER: 'Greater',
    SMALLER: 'Smaller',
    GREATER_OR_EQUAL: 'GreaterOrEqual',
    SMALLER_OR_EQUAL: 'SmallerOrEqual',
    HIGH: 'High',   // For discrete alarms
    LOW: 'Low',     // For discrete alarms
};

/**
 * Check if value meets alarm condition
 */
function checkAlarmCondition(value, limitValue, limitMode) {
    switch (limitMode) {
        case LimitMode.EQUAL:
            return value === limitValue;
        case LimitMode.GREATER:
            return value > limitValue;
        case LimitMode.SMALLER:
            return value < limitValue;
        case LimitMode.GREATER_OR_EQUAL:
            return value >= limitValue;
        case LimitMode.SMALLER_OR_EQUAL:
            return value <= limitValue;
        case LimitMode.HIGH:
            return Boolean(value);
        case LimitMode.LOW:
            return !Boolean(value);
        default:
            return false;
    }
}

/**
 * Alarm Tag State - tracks runtime state of each alarm tag
 */
class AlarmTagState {
    constructor(tagId, alarmType) {
        this.tagId = tagId;
        this.alarmType = alarmType;  // 'analog' or 'discrete'
        
        // State tracking
        this.stateCode = AlarmStateCodes.INACTIVE;
        this.currentValue = null;
        this.rawValue = null;
        
        // Consecutive counting for anti-chatter
        this.consecutiveTrueCount = 0;
        this.consecutiveFalseCount = 0;
        
        // Timestamps
        this.triggeredAt = null;
        this.acknowledgedAt = null;
        this.acknowledgedBy = null;
        this.endedAt = null;
        this.lastReadAt = null;
        this.lastStateChangeAt = null;
        
        // Chatter filter
        this.lastAlarmCondition = false;
        
        // History reference
        this.currentHistoryId = null;
    }

    /**
     * Reset consecutive counters
     */
    resetCounters() {
        this.consecutiveTrueCount = 0;
        this.consecutiveFalseCount = 0;
    }

    /**
     * Check if state change is allowed (chatter filter)
     */
    canChangeState(chatterFilterMs) {
        if (!this.lastStateChangeAt) return true;
        const elapsed = Date.now() - this.lastStateChangeAt.getTime();
        return elapsed >= chatterFilterMs;
    }

    /**
     * Update state to triggered
     */
    trigger(value, historyId) {
        this.stateCode = AlarmStateCodes.ACTIVE;
        this.currentValue = value;
        this.triggeredAt = new Date();
        this.currentHistoryId = historyId;
        this.acknowledgedAt = null;
        this.acknowledgedBy = null;
        this.endedAt = null;
        this.lastStateChangeAt = new Date();
        this.consecutiveTrueCount = 0;
        this.consecutiveFalseCount = 0;
    }

    /**
     * Update state to ended
     */
    end(value) {
        if (this.stateCode === AlarmStateCodes.ACTIVE_ACK) {
            this.stateCode = AlarmStateCodes.ENDED;
        } else {
            this.stateCode = AlarmStateCodes.INACTIVE_ACK; // Needs acknowledgment
        }
        this.currentValue = value;
        this.endedAt = new Date();
        this.lastStateChangeAt = new Date();
        this.consecutiveTrueCount = 0;
        this.consecutiveFalseCount = 0;
    }

    /**
     * Acknowledge the alarm
     */
    acknowledge(user) {
        if (this.stateCode === AlarmStateCodes.ACTIVE) {
            this.stateCode = AlarmStateCodes.ACTIVE_ACK;
        } else if (this.stateCode === AlarmStateCodes.INACTIVE_ACK) {
            this.stateCode = AlarmStateCodes.ENDED;
        }
        this.acknowledgedAt = new Date();
        this.acknowledgedBy = user;
        this.lastStateChangeAt = new Date();
    }

    /**
     * Check if alarm is in an active state
     */
    isActive() {
        return this.stateCode === AlarmStateCodes.ACTIVE || 
               this.stateCode === AlarmStateCodes.ACTIVE_ACK;
    }

    /**
     * Check if alarm needs acknowledgment
     */
    needsAcknowledgment() {
        return this.stateCode === AlarmStateCodes.ACTIVE || 
               this.stateCode === AlarmStateCodes.INACTIVE_ACK;
    }

    /**
     * Export to plain object for JSON serialization
     */
    toJSON() {
        return {
            tagId: this.tagId,
            alarmType: this.alarmType,
            stateCode: this.stateCode,
            stateName: AlarmStateNames[this.stateCode],
            currentValue: this.currentValue,
            rawValue: this.rawValue,
            consecutiveTrueCount: this.consecutiveTrueCount,
            consecutiveFalseCount: this.consecutiveFalseCount,
            triggeredAt: this.triggeredAt?.toISOString(),
            acknowledgedAt: this.acknowledgedAt?.toISOString(),
            acknowledgedBy: this.acknowledgedBy,
            endedAt: this.endedAt?.toISOString(),
            lastReadAt: this.lastReadAt?.toISOString(),
            currentHistoryId: this.currentHistoryId,
        };
    }

    /**
     * Restore from plain object
     */
    static fromJSON(data) {
        const state = new AlarmTagState(data.tagId, data.alarmType);
        state.stateCode = data.stateCode;
        state.currentValue = data.currentValue;
        state.rawValue = data.rawValue;
        state.consecutiveTrueCount = data.consecutiveTrueCount || 0;
        state.consecutiveFalseCount = data.consecutiveFalseCount || 0;
        state.triggeredAt = data.triggeredAt ? new Date(data.triggeredAt) : null;
        state.acknowledgedAt = data.acknowledgedAt ? new Date(data.acknowledgedAt) : null;
        state.acknowledgedBy = data.acknowledgedBy;
        state.endedAt = data.endedAt ? new Date(data.endedAt) : null;
        state.lastReadAt = data.lastReadAt ? new Date(data.lastReadAt) : null;
        state.currentHistoryId = data.currentHistoryId;
        return state;
    }
}

module.exports = {
    AlarmStateCodes,
    AlarmStateNames,
    AlarmSeverity,
    AlarmEventType,
    LimitMode,
    checkAlarmCondition,
    AlarmTagState,
};
