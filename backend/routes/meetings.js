const { createActivityRouter } = require('./activityRouterFactory');

module.exports = createActivityRouter({
  moduleApiName: 'meetings',
  tableName: 'meetings',
  titleColumn: 'meeting_title',
  columns: [
    { name: 'meeting_title' },
    { name: 'related_module' },
    { name: 'related_record_id' },
    { name: 'meeting_type' },
    { name: 'location' },
    { name: 'video_link' },
    { name: 'start_datetime' },
    { name: 'end_datetime' },
    { name: 'organizer_id' },
    { name: 'assigned_user_id' },
    { name: 'status', default: 'Scheduled' },
    { name: 'agenda' },
    { name: 'meeting_notes' },
    { name: 'outcome' },
    { name: 'next_action' },
    // Added with the calendar integration (phase 37). Without these here, a
    // meeting edited from a record page would have its time zone and all-day
    // flag silently wiped — the update rewrites every whitelisted column, so a
    // column missing from this list is a column reset to null on every save.
    { name: 'time_zone' },
    // Defaulted, not nullable: the column is NOT NULL, and the factory writes
    // null for any whitelisted column a request omits — so without this,
    // every meeting created from a record page fails on the constraint.
    { name: 'all_day', default: 0 },
    { name: 'reminder_minutes' },
    { name: 'attendees_json' },
  ],

  // Deleting a meeting anywhere in the CRM also removes it from whichever
  // connected calendars it was pushed to. Loaded lazily so this route file
  // does not drag the calendar stack into every request.
  beforeDelete: (id) => require('../services/calendar/syncService').removeMeetingEverywhere(id),
});
